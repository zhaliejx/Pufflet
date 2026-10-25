// Share links — public, no-login download URLs for individual files. ---------
//
// A share link is a capability token: 32 random bytes, base64url-encoded in
// the URL (/s/<token>). Knowing the token IS the authorization; tokens are
// unguessable and revocable, and every public download is rate-limited and
// audited. Nothing about the owner (email, name, storage chat) is ever
// exposed through a share — only the file's own name/size/type and bytes.
//
// The file bytes still flow through the same vault-aware download pipeline
// as authenticated downloads: encrypted containers are decrypted on the
// server, so share recipients always receive the original bytes.

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { markStateDirty } from "@/lib/state-backup";
import { ShareLink, File } from "@prisma/client";

export class ShareError extends Error {
  constructor(message: string, public readonly status: number = 404, public readonly code?: string) {
    super(message);
    this.name = "ShareError";
  }
}

const MAX_ACTIVE_LINKS_PER_FILE = 20;
const MAX_EXPIRY_DAYS = 3650;

/** 32 random bytes -> 43-char URL-safe token (the entire capability). */
export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface ShareLinkView {
  id: string;
  urlPath: string; // "/s/<token>" — host-agnostic; the UI prefixes its origin
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  downloads: number;
  lastDownloadAt: string | null;
}

export function toView(link: ShareLink): ShareLinkView {
  return {
    id: link.id,
    urlPath: `/s/${link.token}`,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    downloads: link.downloads,
    lastDownloadAt: link.lastDownloadAt?.toISOString() ?? null,
  };
}

async function assertOwnedReadyFile(userId: string, fileId: string): Promise<File> {
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.ownerId !== userId) throw new ShareError("File not found", 404);
  if (file.status !== "READY" || file.trashedAt) {
    throw new ShareError("Only ready, non-trashed files can be shared", 409, "NOT_SHAREABLE");
  }
  if (!file.tgFileId) throw new ShareError("Stored file reference missing", 500, "NO_REFERENCE");
  return file;
}

export async function createShareLink(
  userId: string,
  fileId: string,
  opts: { expiresInDays?: number | null } = {},
): Promise<{ link: ShareLink; file: File }> {
  const file = await assertOwnedReadyFile(userId, fileId);

  let expiresAt: Date | null = null;
  if (opts.expiresInDays != null) {
    const days = Number(opts.expiresInDays);
    if (!Number.isFinite(days) || days < 0 || days > MAX_EXPIRY_DAYS) {
      throw new ShareError(`expiresInDays must be between 0 and ${MAX_EXPIRY_DAYS}`, 400, "BAD_EXPIRY");
    }
    if (days > 0) expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const active = await db.shareLink.count({ where: { fileId, revokedAt: null } });
  if (active >= MAX_ACTIVE_LINKS_PER_FILE) {
    throw new ShareError("Too many active links for this file — revoke some first", 409, "TOO_MANY_LINKS");
  }

  const link = await db.shareLink.create({
    data: {
      token: generateShareToken(),
      fileId: file.id,
      createdBy: userId,
      expiresAt,
    },
  });
  audit("share.create", userId, file.id, `link ${link.id}`);
  markStateDirty();
  return { link, file };
}

export async function listShareLinks(userId: string, fileId: string): Promise<ShareLink[]> {
  await assertOwnedReadyFile(userId, fileId);
  return db.shareLink.findMany({
    where: { fileId },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeShareLink(userId: string, fileId: string, linkId: string): Promise<void> {
  await assertOwnedReadyFile(userId, fileId);
  const link = await db.shareLink.findUnique({ where: { id: linkId } });
  if (!link || link.fileId !== fileId) throw new ShareError("Share link not found", 404);
  if (!link.revokedAt) {
    await db.shareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    audit("share.revoke", userId, fileId, `link ${link.id}`);
    markStateDirty();
  }
}

export interface ResolvedShare {
  link: ShareLink;
  file: File;
}

/**
 * Resolve a token to a live (unrevoked, unexpired) share and its file.
 * Returns null-shaped errors as ShareError(404) — the public surface must
 * never distinguish "bad token" from "revoked file" (no oracle).
 */
export async function resolveShareLink(token: string): Promise<ResolvedShare> {
  if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ShareError("Share link not found", 404, "SHARE_NOT_FOUND");
  }
  const link = await db.shareLink.findUnique({ where: { token }, include: { file: true } });
  if (!link || link.revokedAt) throw new ShareError("Share link not found", 404, "SHARE_NOT_FOUND");
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw new ShareError("Share link not found", 404, "SHARE_NOT_FOUND");
  }
  const file = link.file;
  if (!file || file.status !== "READY" || file.trashedAt || !file.tgFileId) {
    throw new ShareError("Share link not found", 404, "SHARE_NOT_FOUND");
  }
  return { link, file };
}

/** Count the download on the link + audit trail (best-effort caller context). */
export async function recordShareDownload(linkId: string): Promise<void> {
  await db.shareLink
    .update({
      where: { id: linkId },
      data: { downloads: { increment: 1 }, lastDownloadAt: new Date() },
    })
    .catch(() => {});
}

/** Mime types safe to serve inline (browser preview) on PUBLIC endpoints. */
export function isPublicInlineSafe(mimeType: string): boolean {
  return /^(image\/|video\/|audio\/|application\/pdf|text\/plain)/.test(mimeType);
}
