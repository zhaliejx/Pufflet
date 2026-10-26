// Server side of the WebDAV mount: Basic authentication against the existing
// API-key table, DAV path → Pufflet folder/file resolution, the full method
// implementations (PROPFIND/GET/HEAD/PUT/MKCOL/DELETE/MOVE/COPY) and error
// mapping. The API key travels as the Basic password (any username is
// accepted), which reuses the exact credential, scope and revocation model as
// /api/v1 — no new secret class, nothing new to leak.
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { hashApiKey } from "@/lib/crypto";
import { isKeyUsable, keyHasScope, type Scope } from "@/lib/token-utils";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import {
  ServiceError,
  createUploadJob,
  storeUploadStream,
  trashFile,
  trashFolder,
  renameFile,
  moveFile,
  renameFolder,
  moveFolder,
  descendantFolderIds,
  repairFileReferences,
} from "@/lib/files";
import { telegram, TelegramError } from "@/lib/telegram";
import { decodeDownloadStream } from "@/lib/vault";
import { MAX_UPLOAD_BYTES, config } from "@/lib/config";
import { audit } from "@/lib/audit";
import {
  parseDavSegments,
  parseDavDestination,
  buildMultistatus,
  buildDirIndex,
  davEtag,
  type DavResourceProps,
  type DavScope,
} from "@/lib/webdav";

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface DavPrincipal {
  userId: string;
  keyId: string;
  keyName: string;
  scopes: string;
}

function extractBasic(req: Request): { user: string; pass: string } | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return { user: decoded, pass: "" };
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/**
 * Authenticate a DAV request via HTTP Basic where the PASSWORD is a Pufflet
 * API key (tc_live_…). The username is informational — clients like rclone
 * require some non-empty user, but only the key is verified.
 * Returns null for missing/invalid credentials; rate-limited per IP like the
 * Bearer-token path.
 */
export async function authenticateDav(req: Request): Promise<DavPrincipal | null> {
  const creds = extractBasic(req);
  if (!creds || !creds.pass || creds.pass.length > 200 || !creds.pass.startsWith("tc_live_")) {
    return null;
  }
  const rl = rateLimit(`dav-auth:${clientIp(req)}`, 120, 60_000);
  if (!rl.allowed) return null;

  const hash = hashApiKey(creds.pass);
  const key = await db.apiKey.findUnique({ where: { hash } });
  if (!key || !isKeyUsable(key)) {
    audit("dav.auth_failed", null, clientIp(req), creds.user.slice(0, 60) || undefined);
    return null;
  }
  db.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { userId: key.userId, keyId: key.id, keyName: key.name, scopes: key.scopes };
}

export function hasScope(principal: DavPrincipal, required: DavScope | Scope): boolean {
  return keyHasScope(principal.scopes, required);
}

// ---------------------------------------------------------------------------
// Uniform DAV responses (plain text — clients read status codes, not JSON)
// ---------------------------------------------------------------------------

export function davUnauthorized(): Response {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Pufflet", charset="UTF-8"' },
  });
}

export function davForbidden(scope: string): Response {
  return new Response(`This API key is missing the "${scope}" scope for this operation.\n`, { status: 403 });
}

export function davText(status: number, message: string, extra?: Record<string, string>): Response {
  // 204/304 must not carry a body.
  if (status === 204 || status === 304) {
    return new Response(null, { status, headers: extra });
  }
  return new Response(`${message}\n`, { status, headers: extra });
}

/**
 * Map thrown errors to DAV responses. ServiceError keeps its own status,
 * Telegram failures mirror the download routes, everything else is a logged
 * 500 that never leaks internals.
 */
export function davErrorResponse(err: unknown, fallback = "WebDAV operation failed"): Response {
  if (err instanceof ServiceError) return davText(err.status, err.message);
  if (err instanceof TelegramError) {
    const status = err.code === "TG_NOT_CONFIGURED" ? 503 : err.code === "TG_TOO_LARGE" ? 413 : 502;
    console.error("[telegram]", err.code, err.message);
    return davText(status, err.message);
  }
  if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
    return davText(413, `File exceeds the configured upload limit (${config.maxUploadMb} MB)`);
  }
  console.error("[dav]", err instanceof Error ? err.message : err);
  return davText(500, fallback);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface DavNode {
  kind: "folder" | "file";
  id: string;
  name: string;
  size: number;
  mimeType: string | null;
  tgFileId: string | null;
  tgFileUniqueId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DavResolution {
  /** Folder id containing the final segment (null = Pufflet root). */
  parentFolderId: string | null;
  /** true when an INTERMEDIATE segment is missing or shadowed by a file. */
  parentMissing: boolean;
  /** The final segment as a folder/file record — null when it does not exist. */
  node: DavNode | null;
}

const FOLDER_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

const FILE_SELECT = {
  id: true,
  name: true,
  size: true,
  mimeType: true,
  tgFileId: true,
  tgFileUniqueId: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function lookupFile(ownerId: string, folderId: string | null, name: string) {
  return db.file.findFirst({
    where: { ownerId, folderId, name, trashedAt: null, status: "READY" },
    select: FILE_SELECT,
  });
}

/**
 * Walk the folder hierarchy along `segments`. Distinguishes the Pufflet root
 * ({ ok: true, folderId: null }) from a broken path ({ ok: false }).
 */
export async function walkDavFolders(
  ownerId: string,
  segments: string[],
): Promise<{ ok: boolean; folderId: string | null }> {
  let parentId: string | null = null;
  for (const seg of segments) {
    const folder = await db.folder.findFirst({
      where: { ownerId, parentId, name: seg, trashedAt: null },
      select: FOLDER_SELECT,
    });
    if (!folder) return { ok: false, folderId: null };
    parentId = folder.id;
  }
  return { ok: true, folderId: parentId };
}

/**
 * Resolve the full DAV path. When a file and a folder share a name (Pufflet
 * allows it), `prefer` picks the winner for the ambiguous lookup: GET/HEAD/
 * PUT target files, MKCOL/DELETE/MOVE/COPY/PROPFIND target folders.
 */
export async function resolveDavPath(
  ownerId: string,
  segments: string[],
  prefer: "folder" | "file",
): Promise<DavResolution> {
  if (segments.length === 0) {
    return { parentFolderId: null, parentMissing: false, node: null }; // the mount root
  }
  const parentWalk = await walkDavFolders(ownerId, segments.slice(0, -1));
  if (!parentWalk.ok) {
    return { parentFolderId: null, parentMissing: true, node: null };
  }
  const parentFolderId = parentWalk.folderId;
  const name = segments[segments.length - 1];

  const folderHit = await db.folder.findFirst({
    where: { ownerId, parentId: parentFolderId, name, trashedAt: null },
    select: FOLDER_SELECT,
  });
  const fileHit = await lookupFile(ownerId, parentFolderId, name);

  const folderNode: DavNode | null = folderHit
    ? {
        kind: "folder",
        id: folderHit.id,
        name: folderHit.name,
        size: 0,
        mimeType: null,
        tgFileId: null,
        tgFileUniqueId: null,
        createdAt: folderHit.createdAt,
        updatedAt: folderHit.updatedAt,
      }
    : null;
  const fileNode: DavNode | null = fileHit
    ? {
        kind: "file",
        id: fileHit.id,
        name: fileHit.name,
        size: fileHit.size,
        mimeType: fileHit.mimeType,
        tgFileId: fileHit.tgFileId,
        tgFileUniqueId: fileHit.tgFileUniqueId,
        createdAt: fileHit.createdAt,
        updatedAt: fileHit.updatedAt,
      }
    : null;
  const node = prefer === "folder" ? (folderNode ?? fileNode) : (fileNode ?? folderNode);
  if (!node) return { parentFolderId, parentMissing: false, node: null };
  return { parentFolderId, parentMissing: false, node };
}

export async function listDavChildren(ownerId: string, folderId: string | null) {
  const [folders, files] = await Promise.all([
    db.folder.findMany({
      where: { ownerId, parentId: folderId, trashedAt: null },
      select: FOLDER_SELECT,
      orderBy: { name: "asc" },
    }),
    db.file.findMany({
      where: { ownerId, folderId, trashedAt: null, status: "READY" },
      select: FILE_SELECT,
      orderBy: { name: "asc" },
    }),
  ]);
  return { folders, files };
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Feature flag + auth + scope in one step. Returns a Response to send or the principal. */
export async function davGuard(
  req: Request,
  scope: DavScope,
): Promise<{ principal: DavPrincipal } | { response: Response }> {
  if (!config.davEnabled) {
    return { response: davText(404, "Not found\n") };
  }
  const principal = await authenticateDav(req);
  if (!principal) return { response: davUnauthorized() };
  if (!hasScope(principal, scope)) return { response: davForbidden(scope) };
  return { principal };
}

/** Parse the request path into validated segments (400 on structural failure). */
export function davSegmentsOr400(path: string[] | undefined): { segments: string[] } | { response: Response } {
  const segments = parseDavSegments(path, config.maxFolderDepth);
  if (segments === null) {
    return { response: davText(400, "Invalid path\n") };
  }
  return { segments };
}

/** Depth header for PROPFIND: 0 = prop itself, 1 = +children, -1 = recursive. */
export function davDepth(req: Request): 0 | 1 | -1 {
  const raw = (req.headers.get("depth") ?? "1").trim();
  if (raw === "0") return 0;
  if (raw === "1") return 1;
  return -1; // "infinity" and anything else → recursive (bounded walk)
}

function toResource(segments: string[], isFolder: boolean, node: DavNode): DavResourceProps {
  return {
    segments,
    isFolder,
    name: node.name,
    size: node.size,
    mimeType: node.mimeType ?? undefined,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    etag: node.kind === "file" ? davEtag(node.tgFileUniqueId, node.size) : undefined,
  };
}

// ---------------------------------------------------------------------------
// PROPFIND
// ---------------------------------------------------------------------------

const PROPFIND_CAP = 5000;

export async function davPropfind(
  ownerId: string,
  segments: string[],
  depth: 0 | 1 | -1,
): Promise<Response> {
  const resources: DavResourceProps[] = [];

  if (segments.length === 0) {
    resources.push({
      segments: [],
      isFolder: true,
      name: "Pufflet",
      createdAt: new Date(0),
      updatedAt: new Date(),
    });
    if (depth !== 0) await collectChildren(ownerId, null, [], resources, depth, 0);
  } else {
    const { node } = await resolveDavPath(ownerId, segments, "folder");
    if (!node) return davText(404, "Not found\n");
    resources.push(toResource(segments, node.kind === "folder", node));
    if (depth !== 0 && node.kind === "folder") {
      await collectChildren(ownerId, node.id, segments, resources, depth, 1);
    }
  }

  return new Response(buildMultistatus(resources), {
    status: 207,
    headers: {
      "content-type": 'application/xml; charset="utf-8"',
      "cache-control": "private, no-store",
      dav: "1",
    },
  });
}

async function collectChildren(
  ownerId: string,
  folderId: string | null,
  segments: string[],
  out: DavResourceProps[],
  depth: 0 | 1 | -1,
  level: number,
): Promise<void> {
  const { folders, files } = await listDavChildren(ownerId, folderId);
  const childSegments = (name: string) => [...segments, name];
  for (const f of folders) {
    if (out.length >= PROPFIND_CAP) return;
    out.push({
      segments: childSegments(f.name),
      isFolder: true,
      name: f.name,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    });
    if (depth === -1 && level < config.maxFolderDepth) {
      await collectChildren(ownerId, f.id, childSegments(f.name), out, depth, level + 1);
    }
  }
  for (const f of files) {
    if (out.length >= PROPFIND_CAP) return;
    out.push({
      segments: childSegments(f.name),
      isFolder: false,
      name: f.name,
      size: f.size,
      mimeType: f.mimeType,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      etag: davEtag(f.tgFileUniqueId, f.size),
    });
  }
}

// ---------------------------------------------------------------------------
// GET / HEAD
// ---------------------------------------------------------------------------

export async function davGetOrHead(
  ownerId: string,
  req: Request,
  segments: string[],
  method: "GET" | "HEAD",
): Promise<Response> {
  const htmlType = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } as const;

  // Root or a collection → tiny HTML index (browsers / human debugging).
  if (segments.length === 0) {
    const { folders, files } = await listDavChildren(ownerId, null);
    if (method === "HEAD") return davText(200, "", { ...htmlType });
    return new Response(buildDirIndex([], folders.map((f) => f.name), files.map((f) => f.name)), {
      status: 200,
      headers: { ...htmlType },
    });
  }

  const { node } = await resolveDavPath(ownerId, segments, "file");
  if (!node) return davText(404, "Not found\n");

  if (node.kind === "folder") {
    const { folders, files } = await listDavChildren(ownerId, node.id);
    if (method === "HEAD") return davText(200, "", { ...htmlType });
    return new Response(
      buildDirIndex(segments, folders.map((f) => f.name), files.map((f) => f.name)),
      { status: 200, headers: { ...htmlType } },
    );
  }

  const etag = davEtag(node.tgFileUniqueId, node.size);
  const headers: Record<string, string> = {
    "content-type": node.mimeType || "application/octet-stream",
    "content-length": String(node.size),
    etag,
    "last-modified": node.updatedAt.toUTCString(),
    "cache-control": "private, no-store",
    "accept-ranges": "none",
    "x-content-type-options": "nosniff",
  };

  // Conditional-request fast path: unchanged revision → 304 without the
  // Telegram round-trip (repeated syncs revalidate cheaply).
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-store" } });
  }

  if (method === "HEAD") return new Response(null, { status: 200, headers });
  if (!node.tgFileId) return davText(500, "Stored file reference missing\n");

  const { body, repaired } = await telegram().openDownloadStream(node.tgFileId);
  if (repaired) {
    await repairFileReferences(node.id, repaired).catch(() => {});
  }
  const decoded = await decodeDownloadStream(body);
  return new Response(decoded, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

function contentTypeFromHeader(raw: string | null): string {
  if (!raw) return "application/octet-stream";
  const base = raw.split(";")[0].trim();
  return base && base.length <= 100 ? base : "application/octet-stream";
}

export async function davPut(
  ownerId: string,
  segments: string[],
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  declaredLength: number,
): Promise<Response> {
  if (segments.length === 0) return davText(405, "Cannot PUT onto the mount root\n");
  if (!body) return davText(400, "Request body is required\n");
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return davText(413, `File exceeds the configured upload limit (${config.maxUploadMb} MB)`);
  }

  const parentWalk = await walkDavFolders(ownerId, segments.slice(0, -1));
  if (!parentWalk.ok) return davText(409, "Parent collection does not exist\n");
  const parentFolderId = parentWalk.folderId;
  const name = segments[segments.length - 1];

  const existingFolder = await db.folder.findFirst({
    where: { ownerId, parentId: parentFolderId, name, trashedAt: null },
    select: { id: true },
  });
  if (existingFolder) return davText(409, "A collection already exists at that name\n");

  // WebDAV PUT is replace-semantics: park the previous revision in the trash
  // so the upload lands under the EXACT requested name (the ingest pipeline
  // would otherwise auto-dedupe to "name (2)").
  const existingFile = await lookupFile(ownerId, parentFolderId, name);
  const overwriting = Boolean(existingFile);
  if (existingFile) await trashFile(ownerId, existingFile.id);

  const job = await createUploadJob(
    ownerId,
    {
      filename: name,
      size: declaredLength > 0 ? declaredLength : 0,
      mimeType: contentTypeFromHeader(contentType),
      folderId: parentFolderId,
    },
    "webdav",
  );

  // SHA-256 of the plaintext bytes while streaming (checksum + integrity).
  const hash = createHash("sha256");
  const hashed = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );

  const file = await storeUploadStream(ownerId, job.id, hashed, {
    hashStream: (s) => ({ stream: s, digest: () => hash.digest("hex") }),
    uploaderLabel: "webdav",
  });
  audit("dav.put", ownerId, file.id, `${overwriting ? "↻" : "↑"} ${name}`);
  return davText(overwriting ? 204 : 201, overwriting ? "" : `Created ${name}\n`, {
    etag: davEtag(file.tgFileUniqueId, file.size),
  });
}

// ---------------------------------------------------------------------------
// MKCOL
// ---------------------------------------------------------------------------

export async function davMkcol(ownerId: string, segments: string[]): Promise<Response> {
  if (segments.length === 0) return davText(405, "The mount root already exists\n");
  const parentWalk = await walkDavFolders(ownerId, segments.slice(0, -1));
  if (!parentWalk.ok) return davText(409, "Parent collection does not exist\n");
  const parentFolderId = parentWalk.folderId;
  const name = segments[segments.length - 1];

  const clash =
    (await db.folder.findFirst({ where: { ownerId, parentId: parentFolderId, name, trashedAt: null }, select: { id: true } })) ??
    (await lookupFile(ownerId, parentFolderId, name));
  if (clash) return davText(405, "A resource already exists at that name\n");

  const folder = await db.folder.create({ data: { name, ownerId, parentId: parentFolderId } });
  audit("folder.create", ownerId, folder.id, `${name} (webdav)`);
  return davText(201, `Created ${name}\n`);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function davDelete(ownerId: string, segments: string[]): Promise<Response> {
  if (segments.length === 0) return davText(403, "Cannot delete the mount root\n");
  const { node } = await resolveDavPath(ownerId, segments, "folder");
  if (!node) return davText(404, "Not found\n");
  // Soft-delete: the Telegram messages stay until a trash purge, and trashed
  // records disappear from every listing — exactly what DAV clients expect.
  if (node.kind === "folder") await trashFolder(ownerId, node.id);
  else await trashFile(ownerId, node.id);
  return davText(204, "");
}

// ---------------------------------------------------------------------------
// MOVE / COPY
// ---------------------------------------------------------------------------

function destinationOr400(req: Request): { segments: string[] } | { response: Response } {
  const dest = parseDavDestination(req.headers.get("destination"), config.maxFolderDepth);
  if (!dest) return { response: davText(400, "Missing or invalid Destination header\n") };
  return { segments: dest };
}

function overwriteAllowed(req: Request): boolean {
  return (req.headers.get("overwrite") ?? "T").trim().toUpperCase() !== "F";
}

/** Trash the target of an overwrite MOVE/COPY. Kinds must match (checked by caller). */
async function replaceTarget(ownerId: string, target: DavNode, allowOverwrite: boolean): Promise<Response | null> {
  if (!allowOverwrite) return davText(412, "Target exists and Overwrite is F\n");
  if (target.kind === "folder") await trashFolder(ownerId, target.id);
  else await trashFile(ownerId, target.id);
  return null;
}

export async function davMove(ownerId: string, segments: string[], req: Request): Promise<Response> {
  if (segments.length === 0) return davText(403, "Cannot move the mount root\n");
  const { node } = await resolveDavPath(ownerId, segments, "folder");
  if (!node) return davText(404, "Not found\n");

  const dest = destinationOr400(req);
  if ("response" in dest) return dest.response;
  if (dest.segments.length === 0) return davText(403, "Cannot overwrite the mount root\n");
  if (dest.segments.length === segments.length && dest.segments.every((s, i) => s === segments[i])) {
    return davText(403, "Source and destination are the same\n");
  }

  const destWalk = await walkDavFolders(ownerId, dest.segments.slice(0, -1));
  if (!destWalk.ok) return davText(409, "Destination collection does not exist\n");
  const destParentId = destWalk.folderId;
  const destName = dest.segments[dest.segments.length - 1];

  const destResolution = await resolveDavPath(ownerId, dest.segments, "folder");
  if (destResolution.node && destResolution.node.kind !== node.kind) {
    return davText(409, "Cannot overwrite a different resource kind\n");
  }
  if (destResolution.node) {
    const err = await replaceTarget(ownerId, destResolution.node, overwriteAllowed(req));
    if (err) return err;
  }

  const sameName = destName === node.name;
  if (node.kind === "file") {
    const current = await db.file.findFirst({ where: { id: node.id, ownerId }, select: { folderId: true } });
    if (current && current.folderId !== destParentId) await moveFile(ownerId, node.id, destParentId);
    if (!sameName) await renameFile(ownerId, node.id, destName);
  } else {
    const current = await db.folder.findUnique({ where: { id: node.id }, select: { parentId: true } });
    if (current && current.parentId !== destParentId) await moveFolder(ownerId, node.id, destParentId);
    if (!sameName) await renameFolder(ownerId, node.id, destName);
  }
  audit("dav.move", ownerId, node.id, `${node.name} → ${destName}`);
  return davText(destResolution.node ? 204 : 201, destResolution.node ? "" : `Moved to ${destName}\n`);
}

export async function davCopy(ownerId: string, segments: string[], req: Request): Promise<Response> {
  if (segments.length === 0) return davText(403, "Cannot copy the mount root\n");
  const { node } = await resolveDavPath(ownerId, segments, "folder");
  if (!node) return davText(404, "Not found\n");

  const dest = destinationOr400(req);
  if ("response" in dest) return dest.response;
  if (dest.segments.length === 0) return davText(403, "Cannot overwrite the mount root\n");

  const destWalk = await walkDavFolders(ownerId, dest.segments.slice(0, -1));
  if (!destWalk.ok) return davText(409, "Destination collection does not exist\n");
  const destParentId = destWalk.folderId;
  const destName = dest.segments[dest.segments.length - 1];

  const destResolution = await resolveDavPath(ownerId, dest.segments, "folder");
  if (destResolution.node && destResolution.node.kind !== node.kind) {
    return davText(409, "Cannot overwrite a different resource kind\n");
  }
  if (destResolution.node) {
    const err = await replaceTarget(ownerId, destResolution.node, overwriteAllowed(req));
    if (err) return err;
  }

  if (node.kind === "file") {
    const copied = await copyFileBytes(ownerId, node, destParentId, destName);
    audit("dav.copy", ownerId, copied.id, `${node.name} → ${destName}`);
    return davText(201, `Created ${destName}\n`, { etag: davEtag(copied.tgFileUniqueId, copied.size) });
  }

  // Folder copy: bounded pre-count, then recursive byte copies.
  const allFolders = await db.folder.findMany({ where: { ownerId } });
  const descendants = descendantFolderIds(allFolders, node.id);
  const folderIds = [node.id, ...descendants];
  const fileCount = await db.file.count({
    where: { ownerId, folderId: { in: folderIds }, trashedAt: null, status: "READY" },
  });
  if (fileCount > config.davMaxCopyFiles) {
    return davText(413, `Folder copy is limited to ${config.davMaxCopyFiles} files\n`);
  }
  await copyFolderInto(ownerId, node.id, destParentId, destName);
  audit("dav.copy", ownerId, node.id, `folder ${node.name} → ${destName} (${fileCount} files)`);
  return davText(201, `Created ${destName}\n`);
}

/** Stream one stored file into a fresh Pufflet file record (server-side copy). */
async function copyFileBytes(
  ownerId: string,
  src: DavNode,
  destFolderId: string | null,
  destName: string,
): Promise<DavNode> {
  if (src.size > MAX_UPLOAD_BYTES) {
    throw new ServiceError(
      `“${src.name}” is larger than this server's upload limit (${config.maxUploadMb} MB)`,
      413,
      "PAYLOAD_TOO_LARGE",
    );
  }
  if (!src.tgFileId) throw new ServiceError("Stored file reference missing", 500);
  const mimeType = src.mimeType && src.mimeType.length <= 100 ? src.mimeType : "application/octet-stream";
  const job = await createUploadJob(
    ownerId,
    { filename: destName, size: src.size, mimeType, folderId: destFolderId },
    "webdav",
  );
  const { body, repaired } = await telegram().openDownloadStream(src.tgFileId);
  if (repaired) await repairFileReferences(src.id, repaired).catch(() => {});
  const decoded = await decodeDownloadStream(body);
  const file = await storeUploadStream(ownerId, job.id, decoded, { uploaderLabel: "webdav" });
  return {
    kind: "file",
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    tgFileId: file.tgFileId,
    tgFileUniqueId: file.tgFileUniqueId,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

async function copyFolderInto(
  ownerId: string,
  srcFolderId: string,
  destParentId: string | null,
  destName: string,
): Promise<void> {
  const destFolder = await db.folder.create({ data: { name: destName, ownerId, parentId: destParentId } });
  audit("folder.create", ownerId, destFolder.id, `${destName} (webdav copy)`);
  const { folders, files } = await listDavChildren(ownerId, srcFolderId);
  for (const f of files) {
    await copyFileBytes(
      ownerId,
      {
        kind: "file",
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        tgFileId: f.tgFileId,
        tgFileUniqueId: f.tgFileUniqueId,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      },
      destFolder.id,
      f.name,
    );
  }
  for (const d of folders) {
    await copyFolderInto(ownerId, d.id, destFolder.id, d.name);
  }
}
