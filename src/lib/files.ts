// File & folder service layer -------------------------------------------------
// All authorization, lifecycle transitions, and Telegram coordination live
// here so both the website (session) API and the versioned REST API (/v1)
// share one implementation.

import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { sanitizeName } from "@/lib/folder-utils";
import { telegram } from "@/lib/telegram";
import { audit } from "@/lib/audit";
import { encodeUploadStream, obfuscatedStorageName } from "@/lib/vault";
import { Folder, File } from "@prisma/client";

export class ServiceError extends Error {
  constructor(message: string, public readonly status: number = 400, public readonly code?: string) {
    super(message);
    this.name = "ServiceError";
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export function normalizeName(name: string): string {
  return name.toLowerCase();
}

/** De-duplicate: "report.pdf" -> "report (2).pdf" when the name is taken. */
export async function uniqueFileName(ownerId: string, folderId: string | null, wanted: string): Promise<string> {
  const existing = await db.file.findMany({
    where: { ownerId, folderId, trashedAt: null },
    select: { name: true },
  });
  const taken = new Set(existing.map((e) => e.name));
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.lastIndexOf(".");
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

export async function uniqueFolderName(ownerId: string, parentId: string | null, wanted: string): Promise<string> {
  const existing = await db.folder.findMany({
    where: { ownerId, parentId, trashedAt: null },
    select: { name: true },
  });
  const taken = new Set(existing.map((e) => e.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${wanted} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted} (${Date.now()})`;
}

/** All folders owned by the user (flat) — used for tree ops at personal scale. */
async function allFolders(ownerId: string): Promise<Folder[]> {
  return db.folder.findMany({ where: { ownerId } });
}

export function descendantFolderIds(folders: Folder[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentId) {
      const list = childrenOf.get(f.parentId) ?? [];
      list.push(f.id);
      childrenOf.set(f.parentId, list);
    }
  }
  const out = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

async function assertFolderAccess(folderId: string, ownerId: string): Promise<Folder> {
  const folder = await db.folder.findUnique({ where: { id: folderId } });
  if (!folder || folder.ownerId !== ownerId) {
    throw new ServiceError("Folder not found", 404);
  }
  return folder;
}

async function assertFileAccess(fileId: string, ownerId: string): Promise<File> {
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.ownerId !== ownerId) {
    throw new ServiceError("File not found", 404);
  }
  return file;
}

// --------------------------------------------------------------------------
// Listing / breadcrumbs
// --------------------------------------------------------------------------

export type ListView = "folder" | "recent" | "starred" | "trash" | "search";

export interface ListOptions {
  view: ListView;
  folderId?: string | null;
  q?: string;
  sort?: "name" | "size" | "updatedAt";
  dir?: "asc" | "desc";
}

const SORT_FIELDS = {
  name: "normalizedName",
  size: "size",
  updatedAt: "updatedAt",
} as const;

export async function listFiles(ownerId: string, opts: ListOptions) {
  const order = {
    [SORT_FIELDS[opts.sort ?? "updatedAt"]]: opts.dir ?? (opts.sort === "name" ? "asc" : "desc"),
  };

  if (opts.view === "folder") {
    if (opts.folderId) await assertFolderAccess(opts.folderId, ownerId);
    return db.file.findMany({
      where: { ownerId, folderId: opts.folderId ?? null, trashedAt: null, status: "READY" },
      orderBy: order,
    });
  }
  if (opts.view === "recent") {
    return db.file.findMany({
      where: { ownerId, trashedAt: null, status: "READY" },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }
  if (opts.view === "starred") {
    return db.file.findMany({
      where: { ownerId, trashedAt: null, starred: true, status: "READY" },
      orderBy: order,
    });
  }
  if (opts.view === "trash") {
    return db.file.findMany({
      where: { ownerId, trashedAt: { not: null } },
      orderBy: { trashedAt: "desc" },
    });
  }
  // search
  const q = (opts.q ?? "").trim().toLowerCase();
  return db.file.findMany({
    where: {
      ownerId,
      trashedAt: null,
      status: "READY",
      ...(q ? { normalizedName: { contains: q } } : {}),
    },
    orderBy: order,
    take: 200,
  });
}

export async function breadcrumbs(ownerId: string, folderId: string | null): Promise<{ id: string; name: string }[]> {
  if (!folderId) return [];
  const folders = await allFolders(ownerId);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: { id: string; name: string }[] = [];
  let cur = byId.get(folderId);
  let hops = 0;
  while (cur && hops < config.maxFolderDepth) {
    chain.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    hops++;
  }
  return chain;
}

// --------------------------------------------------------------------------
// Upload jobs
// --------------------------------------------------------------------------

export interface CreateJobInput {
  filename: string;
  size: number;
  mimeType?: string;
  folderId?: string | null;
}

export async function createUploadJob(
  ownerId: string,
  input: CreateJobInput,
  uploaderLabel: string,
): Promise<{ id: string }> {
  const name = sanitizeName(input.filename);
  if (!name) throw new ServiceError("Invalid filename", 400, "BAD_FILENAME");
  if (!Number.isInteger(input.size) || input.size < 0) {
    throw new ServiceError("Invalid size", 400, "BAD_SIZE");
  }
  if (input.folderId) {
    const folder = await assertFolderAccess(input.folderId, ownerId);
    if (folder.trashedAt) throw new ServiceError("Cannot upload into a trashed folder", 400);
  }
  const job = await db.uploadJob.create({
    data: {
      userId: ownerId,
      filename: name,
      size: input.size,
      mimeType: input.mimeType ?? "application/octet-stream",
      folderId: input.folderId ?? null,
      status: "PENDING",
    },
  });
  audit("file.upload", ownerId, job.id, `pending ${name}`);
  return { id: job.id };
}

export async function getUploadJob(ownerId: string, jobId: string) {
  const job = await db.uploadJob.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== ownerId) throw new ServiceError("Upload job not found", 404);
  return job;
}

/**
 * Consume the raw request stream, push it to Telegram, then (and only then)
 * record the File row. Telegram + the DB cannot share a transaction, so the
 * design is: Telegram first; DB success row last; failures leave the job in
 * FAILED with no phantom File. Re-PUT on a FAILED job is allowed (retry).
 *
 * Vault: the stream is encrypted + padded before a single byte leaves the
 * server, and Telegram receives an opaque "pf-<hex>.bin" name with a generic
 * content type. The real name / mime / size live only in this DB; downloads
 * decrypt transparently (see /download routes).
 */
export async function storeUploadStream(
  ownerId: string,
  jobId: string,
  body: ReadableStream<Uint8Array>,
  opts?: { hashStream?: (s: ReadableStream<Uint8Array>) => { stream: ReadableStream<Uint8Array>; digest: () => string } },
): Promise<File> {
  const job = await getUploadJob(ownerId, jobId);
  if (job.status === "READY" && job.fileId) {
    const existing = await db.file.findUnique({ where: { id: job.fileId } });
    if (existing) return existing; // idempotent re-PUT
  }
  if (job.status === "CANCELED") throw new ServiceError("Upload was canceled", 409);

  await db.uploadJob.update({ where: { id: job.id }, data: { status: "UPLOADING", error: null } });

  let stream = body;
  let digest: (() => string) | undefined;
  if (opts?.hashStream) {
    const h = opts.hashStream(stream);
    stream = h.stream;
    digest = h.digest; // hashes PLAINTEXT bytes (pre-vault) — verifiable checksums
  }

  try {
    await db.uploadJob.update({ where: { id: job.id }, data: { status: "STORING" } });
    const encoded = await encodeUploadStream(stream);
    const stored = await telegram().sendDocument(
      obfuscatedStorageName(),
      "application/octet-stream", // never leak the real mime type to Telegram
      encoded.stream,
    );

    const finalName = await uniqueFileName(ownerId, job.folderId, job.filename);
    const file = await db.$transaction(async (tx) => {
      const created = await tx.file.create({
        data: {
          name: finalName,
          normalizedName: normalizeName(finalName),
          // plaintext size (counted by the vault) wins; Telegram's reported
          // size is inflated by the padding + container overhead
          size: encoded.plaintextBytes?.() || job.size || stored.size,
          mimeType: job.mimeType ?? stored.mimeType ?? "application/octet-stream",
          status: "READY",
          ownerId,
          folderId: job.folderId,
          sha256: digest?.(),
          uploaderLabel: "web",
          tgChatId: stored.chatId,
          tgMessageId: stored.messageId,
          tgFileId: stored.fileId,
          tgFileUniqueId: stored.fileUniqueId,
        },
      });
      await tx.uploadJob.update({
        where: { id: job.id },
        data: { status: "READY", fileId: created.id, error: null },
      });
      return created;
    });
    audit("file.upload", ownerId, file.id, finalName);
    return file;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.uploadJob
      .update({ where: { id: job.id }, data: { status: "FAILED", error: message.slice(0, 300) } })
      .catch(() => {});
    throw err;
  }
}

export async function cancelUploadJob(ownerId: string, jobId: string): Promise<void> {
  const job = await getUploadJob(ownerId, jobId);
  if (job.status === "READY") throw new ServiceError("Upload already completed", 409);
  await db.uploadJob.update({ where: { id: job.id }, data: { status: "CANCELED" } });
}

// --------------------------------------------------------------------------
// File mutations
// --------------------------------------------------------------------------

export async function renameFile(ownerId: string, fileId: string, rawName: string): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  const name = sanitizeName(rawName);
  if (!name) throw new ServiceError("Invalid filename", 400);
  const finalName = await uniqueFileName(ownerId, file.folderId, name);
  const updated = await db.file.update({
    where: { id: file.id },
    data: { name: finalName, normalizedName: normalizeName(finalName) },
  });
  audit("file.rename", ownerId, file.id, finalName);
  return updated;
}

export async function moveFile(ownerId: string, fileId: string, folderId: string | null): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  if (folderId) {
    const folder = await assertFolderAccess(folderId, ownerId);
    if (folder.trashedAt) throw new ServiceError("Cannot move into a trashed folder", 400);
  }
  const finalName = await uniqueFileName(ownerId, folderId, file.name);
  const updated = await db.file.update({
    where: { id: file.id },
    data: { folderId, name: finalName, normalizedName: normalizeName(finalName) },
  });
  audit("file.move", ownerId, file.id, folderId ?? "root");
  return updated;
}

export async function setStar(ownerId: string, fileId: string, starred: boolean): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  const updated = await db.file.update({ where: { id: file.id }, data: { starred } });
  audit("file.star", ownerId, file.id, String(starred));
  return updated;
}

/** Soft delete (reversible). The Telegram message is kept until purge. */
export async function trashFile(ownerId: string, fileId: string): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  if (file.trashedAt) return file;
  const updated = await db.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });
  audit("file.trash", ownerId, file.id, file.name);
  return updated;
}

export async function restoreFile(ownerId: string, fileId: string): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  if (!file.trashedAt) return file;
  if (file.folderId) {
    const folder = await db.folder.findUnique({ where: { id: file.folderId } });
    if (folder?.trashedAt) throw new ServiceError("Restore its parent folder first", 409);
  }
  const updated = await db.file.update({ where: { id: file.id }, data: { trashedAt: null } });
  audit("file.restore", ownerId, file.id, file.name);
  return updated;
}

/**
 * Permanent delete: remove the underlying Telegram message FIRST, then the
 * row. If Telegram fails, the row is kept so the operation can be retried —
 * we never report success we did not achieve.
 */
export async function purgeFile(ownerId: string, fileId: string): Promise<void> {
  const file = await assertFileAccess(fileId, ownerId);
  if (file.tgChatId && file.tgMessageId) {
    try {
      await telegram().deleteMessage(file.tgChatId, file.tgMessageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceError(`Telegram deletion failed, file kept for retry: ${message}`, 502, "TG_DELETE_FAILED");
    }
  }
  await db.file.delete({ where: { id: file.id } });
  audit("file.purge", ownerId, file.id, file.name);
}

export async function emptyTrash(ownerId: string): Promise<{ purged: number; failed: number; errors: string[] }> {
  const files = await db.file.findMany({ where: { ownerId, trashedAt: { not: null } } });
  let purged = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      await purgeFile(ownerId, file.id);
      purged++;
    } catch (err) {
      failed++;
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { purged, failed, errors: errors.slice(0, 10) };
}

// --------------------------------------------------------------------------
// Folders
// --------------------------------------------------------------------------

export async function createFolder(ownerId: string, rawName: string, parentId: string | null): Promise<Folder> {
  const name = sanitizeName(rawName);
  if (!name) throw new ServiceError("Invalid folder name", 400);
  if (parentId) {
    const parent = await assertFolderAccess(parentId, ownerId);
    if (parent.trashedAt) throw new ServiceError("Cannot create inside a trashed folder", 400);
  }
  const finalName = await uniqueFolderName(ownerId, parentId, name);
  const folder = await db.folder.create({ data: { name: finalName, ownerId, parentId } });
  audit("folder.create", ownerId, folder.id, finalName);
  return folder;
}

export async function listFolders(ownerId: string, opts: { all?: boolean } = {}) {
  return db.folder.findMany({
    where: { ownerId, ...(opts.all ? {} : { trashedAt: null }) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, parentId: true, trashedAt: true, createdAt: true },
  });
}

export async function renameFolder(ownerId: string, folderId: string, rawName: string): Promise<Folder> {
  const folder = await assertFolderAccess(folderId, ownerId);
  const name = sanitizeName(rawName);
  if (!name) throw new ServiceError("Invalid folder name", 400);
  const finalName = await uniqueFolderName(ownerId, folder.parentId, name);
  const updated = await db.folder.update({ where: { id: folder.id }, data: { name: finalName } });
  audit("folder.rename", ownerId, folder.id, finalName);
  return updated;
}

export async function moveFolder(ownerId: string, folderId: string, newParentId: string | null): Promise<Folder> {
  const folder = await assertFolderAccess(folderId, ownerId);
  if (newParentId) {
    const parent = await assertFolderAccess(newParentId, ownerId);
    if (parent.trashedAt) throw new ServiceError("Cannot move into a trashed folder", 400);
    if (parent.id === folder.parentId) return folder;
  } else if (!folder.parentId) {
    return folder;
  }
  const folders = await allFolders(ownerId);
  const { wouldCreateCycle } = await import("@/lib/folder-utils");
  if (wouldCreateCycle(folders, folderId, newParentId)) {
    throw new ServiceError("Cannot move a folder into itself or its own subtree", 400, "CYCLE");
  }
  const finalName = await uniqueFolderName(ownerId, newParentId, folder.name);
  const updated = await db.folder.update({
    where: { id: folder.id },
    data: { parentId: newParentId, name: finalName },
  });
  audit("folder.move", ownerId, folder.id, newParentId ?? "root");
  return updated;
}

/**
 * Trash a folder subtree. Every row affected by THIS operation shares one
 * trashedAt timestamp so a later subtree restore can restore exactly what was
 * trashed together (and not things trashed individually earlier).
 */
export async function trashFolder(ownerId: string, folderId: string): Promise<{ when: Date; files: number }> {
  const folder = await assertFolderAccess(folderId, ownerId);
  if (folder.trashedAt) return { when: folder.trashedAt, files: 0 };
  const when = new Date();
  const folders = await allFolders(ownerId);
  const ids = Array.from(descendantFolderIds(folders, folderId));
  await db.$transaction([
    db.folder.updateMany({ where: { id: { in: ids } }, data: { trashedAt: when } }),
    db.file.updateMany({ where: { ownerId, folderId: { in: ids } }, data: { trashedAt: when } }),
  ]);
  audit("folder.trash", ownerId, folderId, `${ids.length} folders`);
  return { when, files: ids.length };
}

export async function restoreFolder(ownerId: string, folderId: string): Promise<void> {
  const folder = await assertFolderAccess(folderId, ownerId);
  if (!folder.trashedAt) return;
  const when = folder.trashedAt;
  if (folder.parentId) {
    const parent = await db.folder.findUnique({ where: { id: folder.parentId } });
    if (parent?.trashedAt) throw new ServiceError("Restore its parent folder first", 409);
  }
  const folders = await allFolders(ownerId);
  const ids = Array.from(descendantFolderIds(folders, folderId));
  await db.$transaction([
    db.folder.updateMany({ where: { id: { in: ids }, trashedAt: when }, data: { trashedAt: null } }),
    db.file.updateMany({ where: { ownerId, folderId: { in: ids }, trashedAt: when }, data: { trashedAt: null } }),
  ]);
  audit("folder.restore", ownerId, folderId);
}

export async function purgeFolder(ownerId: string, folderId: string): Promise<{ purged: number; failed: number; errors: string[] }> {
  const folder = await assertFolderAccess(folderId, ownerId);
  if (!folder.trashedAt) throw new ServiceError("Move the folder to trash first", 400);
  const folders = await allFolders(ownerId);
  const ids = Array.from(descendantFolderIds(folders, folderId));
  const files = await db.file.findMany({ where: { ownerId, folderId: { in: ids } } });

  let purged = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (file.tgChatId && file.tgMessageId) {
        await telegram().deleteMessage(file.tgChatId, file.tgMessageId);
      }
      await db.file.delete({ where: { id: file.id } });
      purged++;
    } catch (err) {
      failed++;
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // only remove folder rows whose files are all gone
  const remaining = await db.file.count({ where: { ownerId, folderId: { in: ids } } });
  if (remaining === 0) {
    // delete deepest-first
    const byId = new Map(folders.map((f) => [f.id, f]));
    const depth = (id: string): number => {
      let d = 0;
      let cur = byId.get(id);
      while (cur?.parentId && d < config.maxFolderDepth) {
        cur = byId.get(cur.parentId);
        d++;
      }
      return d;
    };
    const ordered = ids.sort((a, b) => depth(b) - depth(a));
    for (const id of ordered) {
      await db.folder.delete({ where: { id } }).catch(() => {});
    }
  }
  audit("folder.purge", ownerId, folderId, `${purged} files`);
  return { purged, failed, errors: errors.slice(0, 10) };
}

// --------------------------------------------------------------------------
// Download + stats
// --------------------------------------------------------------------------

export async function getFileForDownload(ownerId: string, fileId: string): Promise<File> {
  const file = await assertFileAccess(fileId, ownerId);
  if (file.status !== "READY") throw new ServiceError("File is not ready", 409);
  if (file.trashedAt) throw new ServiceError("File is in the trash", 409);
  if (!file.tgFileId) throw new ServiceError("Stored file reference missing", 500);
  audit("file.download", ownerId, file.id, file.name);
  return file;
}

export async function stats(ownerId: string) {
  const [fileCount, sizeAgg, folderCount, starred, trashed, failedJobs] = await Promise.all([
    db.file.count({ where: { ownerId, trashedAt: null, status: "READY" } }),
    db.file.aggregate({ where: { ownerId, trashedAt: null, status: "READY" }, _sum: { size: true } }),
    db.folder.count({ where: { ownerId, trashedAt: null } }),
    db.file.count({ where: { ownerId, trashedAt: null, starred: true } }),
    db.file.count({ where: { ownerId, trashedAt: { not: null } } }),
    db.uploadJob.count({ where: { userId: ownerId, status: "FAILED" } }),
  ]);
  return {
    files: fileCount,
    bytes: sizeAgg._sum.size ?? 0,
    folders: folderCount,
    starred,
    trash: trashed,
    failedUploads: failedJobs,
  };
}
