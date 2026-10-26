// rclone service layer ----------------------------------------------------------
// All authorization, credential custody, and sync-job orchestration for the
// rclone integration lives here so the website (session) API and the REST API
// (/api/v1) share one implementation — same pattern as files.ts.
//
// Security model:
//   - Provider secrets are stored AES-256-GCM encrypted (rclone-crypto.ts),
//     decrypted ONLY inside the process, and materialized into a 0600 temp
//     rclone config per invocation (rclone-exec.ts). They never appear in API
//     responses, logs, or audit rows.
//   - Every remote row is bound to its owner; every job row to its user.
//   - Sync jobs run one-at-a-time per user, are abortable (cancel endpoint),
//     and get swept to FAILED if the server restarted mid-run.

import { db } from "@/lib/db";
import { MAX_UPLOAD_BYTES, config } from "@/lib/config";
import { audit } from "@/lib/audit";
import {
  ServiceError,
  createUploadJob,
  descendantFolderIds,
  ensureFolderPaths,
  repairFileReferences,
  storeUploadStream,
} from "@/lib/files";
import { telegram } from "@/lib/telegram";
import { decodeDownloadStream } from "@/lib/vault";
import {
  RCLONE_JOB_KINDS,
  configComplete,
  hasSecrets,
  maskRcloneConfig,
  rcloneTypeDef,
  sanitizeRcloneConfig,
  sortEntries,
  validateRemoteName,
  validateRemotePath,
  type RcloneConfig,
  type RcloneEntry,
} from "@/lib/rclone";
import {
  RcloneError,
  lsJson,
  openRemoteStream,
  rcloneBinary,
  rcloneMkdir,
  rcloneRcat,
  rcloneVersion,
  statRemotePath,
} from "@/lib/rclone-exec";
import { decryptRcloneConfig, encryptRcloneConfig } from "@/lib/rclone-crypto";
import { Folder, RcloneJob, RcloneRemote } from "@prisma/client";

type RemoteRow = RcloneRemote;
type JobRow = RcloneJob;

// ---------------------------------------------------------------------------
// Serialization (secret-free by construction)
// ---------------------------------------------------------------------------

/**
 * API view of a remote. `cfg` (the DECRYPTED provider options) is optional:
 * when present the non-secret fields are echoed for dialog prefill and the
 * secrets collapse to bullets. The stored `configEnc` blob is NEVER parsed
 * or echoed here — responses cannot leak credentials by construction.
 */
export function toRemoteJson(remote: RemoteRow, cfg?: RcloneConfig | null) {
  return {
    id: remote.id,
    name: remote.name,
    type: remote.type,
    typeLabel: rcloneTypeDef(remote.type)?.label ?? remote.type,
    status: remote.status,
    lastError: remote.lastError,
    lastCheckedAt: remote.lastCheckedAt?.toISOString() ?? null,
    createdAt: remote.createdAt.toISOString(),
    updatedAt: remote.updatedAt.toISOString(),
    config: cfg ? maskRcloneConfig(remote.type, cfg) : {},
    hasSecrets: cfg ? hasSecrets(remote.type, cfg) : true, // unknown → assume set
  };
}

export function toJobJson(job: Omit<JobRow, "remote"> & { remote?: { id: string; name: string; type: string } | null }) {
  return {
    id: job.id,
    kind: job.kind,
    remoteId: job.remoteId,
    remote: job.remote ? { id: job.remote.id, name: job.remote.name, type: job.remote.type } : undefined,
    remotePath: job.remotePath,
    folderId: job.folderId,
    status: job.status,
    totalFiles: job.totalFiles,
    doneFiles: job.doneFiles,
    skipped: job.skipped,
    failed: job.failed,
    bytes: Number(job.bytes),
    lastError: job.lastError,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Remote CRUD
// ---------------------------------------------------------------------------

async function assertRemote(remoteId: string, ownerId: string): Promise<RemoteRow> {
  const remote = await db.rcloneRemote.findUnique({ where: { id: remoteId } });
  if (!remote || remote.ownerId !== ownerId) throw new ServiceError("Remote not found", 404);
  return remote;
}

/** Decrypt provider options for a remote the caller is authorized to use. */
async function decryptRemote(remote: RemoteRow): Promise<{ name: string; type: string; cfg: RcloneConfig }> {
  try {
    const cfg = await decryptRcloneConfig<RcloneConfig>(remote.id, remote.configEnc);
    return { name: remote.name, type: remote.type, cfg };
  } catch (err) {
    console.error("[rclone] config decrypt failed for remote", remote.id, err instanceof Error ? err.message : err);
    throw new ServiceError(
      "The remote's stored credentials could not be decrypted (server key changed?). Re-save the remote.",
      409,
      "REMOTE_DECRYPT",
    );
  }
}

export async function listRemotes(ownerId: string) {
  const rows = await db.rcloneRemote.findMany({
    where: { ownerId },
    orderBy: { createdAt: "asc" },
  });
  // Decryption is local AES per row (cheap at personal scale); failures render
  // an empty masked summary and surface on the next test/edit instead.
  return Promise.all(
    rows.map(async (row) => {
      const { cfg } = await decryptRemote(row).catch(() => ({ cfg: null }));
      return toRemoteJson(row, cfg);
    }),
  );
}

export interface RemoteInput {
  name?: unknown;
  type?: unknown;
  config?: unknown;
}

export async function createRemote(ownerId: string, input: RemoteInput): Promise<{ remote: RemoteRow; cfg: RcloneConfig }> {
  const name = validateRemoteName(typeof input.name === "string" ? input.name.trim() : "");
  if (!name) {
    throw new ServiceError(
      "Remote name must be 1-63 characters: lowercase letters, digits, hyphens (it is used as rclone's remote id)",
      400,
      "BAD_REMOTE_NAME",
    );
  }
  const type = typeof input.type === "string" ? input.type : "";
  if (!rcloneTypeDef(type)) throw new ServiceError("Unknown rclone backend type", 400, "BAD_REMOTE_TYPE");

  const sanitized = sanitizeRcloneConfig(type, input.config);
  if ("error" in sanitized) throw new ServiceError(sanitized.error, 400, "BAD_REMOTE_CONFIG");
  const missing = configComplete(type, sanitized.config);
  if (missing.length) {
    throw new ServiceError(`Missing required field(s): ${missing.join(", ")}`, 400, "INCOMPLETE_CONFIG");
  }

  const dup = await db.rcloneRemote.findUnique({ where: { name } });
  if (dup) throw new ServiceError(`A remote named “${name}” already exists`, 409, "REMOTE_EXISTS");

  const remote = await db.rcloneRemote.create({
    data: {
      ownerId,
      name,
      type,
      configEnc: "", // bound-encrypted blob is written right after the id exists
      status: "unknown",
    },
  });
  const final = await db.rcloneRemote.update({
    where: { id: remote.id },
    data: { configEnc: await encryptRcloneConfig(remote.id, sanitized.config) },
  });
  audit("rclone.remote_create", ownerId, final.id, `${final.name} (${final.type})`);
  return { remote: final, cfg: sanitized.config };
}

export async function updateRemote(
  ownerId: string,
  remoteId: string,
  input: RemoteInput,
): Promise<{ remote: RemoteRow; cfg: RcloneConfig }> {
  const remote = await assertRemote(remoteId, ownerId);
  const { cfg: oldCfg } = await decryptRemote(remote);

  // Rename (optional). Same hard charset as create.
  let name = remote.name;
  const wantedName = typeof input.name === "string" ? input.name.trim() : null;
  if (wantedName && wantedName !== remote.name) {
    const valid = validateRemoteName(wantedName);
    if (!valid) throw new ServiceError("Invalid remote name (lowercase letters, digits, hyphens)", 400, "BAD_REMOTE_NAME");
    const dup = await db.rcloneRemote.findUnique({ where: { name: valid } });
    if (dup && dup.id !== remote.id) throw new ServiceError(`A remote named “${valid}” already exists`, 409, "REMOTE_EXISTS");
    name = valid;
  }

  const type = typeof input.type === "string" ? input.type : remote.type;
  if (!rcloneTypeDef(type)) throw new ServiceError("Unknown rclone backend type", 400, "BAD_REMOTE_TYPE");

  // Merge semantics: omitted fields keep their stored value; a client CANNOT
  // retrieve a stored secret (responses are masked), so sending "" or the
  // mask placeholder means "unchanged". Only a genuinely new non-empty value
  // replaces a secret.
  const sanitized = sanitizeRcloneConfig(type, input.config ?? {});
  if ("error" in sanitized) throw new ServiceError(sanitized.error, 400, "BAD_REMOTE_CONFIG");
  const merged: RcloneConfig = { ...oldCfg, type };
  for (const [key, value] of Object.entries(sanitized.config)) {
    if (key === "type") continue;
    merged[key] = value;
  }
  const missing = configComplete(type, merged);
  if (missing.length) {
    throw new ServiceError(`Missing required field(s): ${missing.join(", ")}`, 400, "INCOMPLETE_CONFIG");
  }

  const updated = await db.rcloneRemote.update({
    where: { id: remote.id },
    data: {
      name,
      type,
      configEnc: await encryptRcloneConfig(remote.id, merged),
      status: "unknown", // credentials changed → previous verdict is stale
      lastError: null,
      lastCheckedAt: null,
    },
  });
  audit("rclone.remote_update", ownerId, updated.id, `${updated.name} (${updated.type})`);
  return { remote: updated, cfg: merged };
}

export async function deleteRemote(ownerId: string, remoteId: string): Promise<void> {
  const remote = await assertRemote(remoteId, ownerId);
  // Abort any in-flight sync against this remote, then cascade deletes jobs.
  for (const job of await db.rcloneJob.findMany({
    where: { remoteId: remote.id, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  })) {
    abortRcloneJob(job.id);
  }
  await db.rcloneRemote.delete({ where: { id: remote.id } });
  audit("rclone.remote_delete", ownerId, remote.id, `${remote.name} (${remote.type})`);
}

/** Connectivity check: list the remote root, persist the verdict on the row. */
export async function testRemote(ownerId: string, remoteId: string) {
  const remote = await assertRemote(remoteId, ownerId);
  const { name, cfg } = await decryptRemote(remote);
  try {
    await lsJson(name, cfg, "");
    const updated = await db.rcloneRemote.update({
      where: { id: remote.id },
      data: { status: "ok", lastError: null, lastCheckedAt: new Date() },
    });
    audit("rclone.remote_test", ownerId, remote.id, `${remote.name}: ok`);
    return { remote: toRemoteJson(updated, cfg), ok: true as const };
  } catch (err) {
    const message = rcloneSafeMessage(err);
    const updated = await db.rcloneRemote
      .update({
        where: { id: remote.id },
        data: { status: "error", lastError: message.slice(0, 300), lastCheckedAt: new Date() },
      })
      .catch(() => null);
    audit("rclone.remote_test", ownerId, remote.id, `${remote.name}: failed`);
    return { remote: updated ? toRemoteJson(updated, cfg) : toRemoteJson(remote, cfg), ok: false as const, error: message };
  }
}

// ---------------------------------------------------------------------------
// Browse / single-file transfers
// ---------------------------------------------------------------------------

export async function browseRemote(ownerId: string, remoteId: string, rawPath: string) {
  const remote = await assertRemote(remoteId, ownerId);
  const path = validateRemotePath(rawPath);
  if (path === null) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  const { name, cfg } = await decryptRemote(remote);
  const entries: RcloneEntry[] = await lsJson(name, cfg, path);
  return {
    remote: { id: remote.id, name: remote.name, type: remote.type },
    path,
    entries: sortEntries(entries).slice(0, config.rcloneMaxBrowseEntries),
    truncated: entries.length > config.rcloneMaxBrowseEntries,
  };
}

function rcloneSafeMessage(err: unknown): string {
  if (err instanceof RcloneError) return err.message;
  if (err instanceof ServiceError) return err.message;
  return "The rclone operation failed";
}

/** Map any thrown error into a ServiceError with a safe, user-facing message. */
function asServiceError(err: unknown, fallback: string): ServiceError {
  if (err instanceof ServiceError) return err;
  if (err instanceof RcloneError) {
    const status = err.op.code === "REMOTE_NOT_FOUND" ? 404 : err.op.code === "RCLONE_MISSING" ? 503 : 502;
    return new ServiceError(err.message, status, err.op.code);
  }
  console.error("[rclone]", err instanceof Error ? err.message : err);
  return new ServiceError(fallback, 500);
}

/** Stat a remote object after ownership checks (for download headers). */
export async function statRemotePathForOwner(ownerId: string, remoteId: string, rawPath: string): Promise<RcloneEntry | null> {
  const remote = await assertRemote(remoteId, ownerId);
  const path = validateRemotePath(rawPath);
  if (path === null) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  const { name, cfg } = await decryptRemote(remote);
  return statRemotePath(name, cfg, path);
}

/** Open a remote file's byte stream after ownership checks (rclone cat). */
export async function streamRemoteFile(
  ownerId: string,
  remoteId: string,
  rawPath: string,
  signal?: AbortSignal | null,
): Promise<{ stream: ReadableStream<Uint8Array>; started: Promise<true>; closed: Promise<void> }> {
  const remote = await assertRemote(remoteId, ownerId);
  const path = validateRemotePath(rawPath);
  if (path === null) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  const { name, cfg } = await decryptRemote(remote);
  return openRemoteStream(name, cfg, path, signal);
}

/**
 * Push ONE Pufflet file to the remote (`rclone rcat`, streamed — no temp
 * file on the server). `targetPath` is the full remote destination (a
 * trailing "/" places the file inside that directory under its own name).
 */
export async function sendFileToRemote(
  ownerId: string,
  remoteId: string,
  fileId: string,
  rawTarget: string,
  signal?: AbortSignal | null,
): Promise<{ bytes: number; path: string; remote: { id: string; name: string } }> {
  const remote = await assertRemote(remoteId, ownerId);
  const { name, cfg } = await decryptRemote(remote);

  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.ownerId !== ownerId) throw new ServiceError("File not found", 404);
  if (file.status !== "READY" || file.trashedAt) throw new ServiceError("File is not available for transfer", 409);
  if (!file.tgFileId) throw new ServiceError("Stored file reference missing", 500);

  const cleaned = validateRemotePath(rawTarget);
  if (cleaned === null) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  const target = cleaned.endsWith("/") ? validateRemotePath(`${cleaned}${file.name}`) : cleaned;
  if (!target) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");

  const { body, repaired } = await telegram().openDownloadStream(file.tgFileId);
  if (repaired) {
    await repairFileReferences(file.id, repaired).catch(() => {});
  }
  const decoded = await decodeDownloadStream(body);

  try {
    await rcloneRcat(name, cfg, target, decoded, signal);
  } catch (err) {
    throw asServiceError(err, "Sending the file to the remote failed");
  }
  audit("rclone.send", ownerId, file.id, `→ ${remote.name}:${target}`);
  return { bytes: file.size, path: target, remote: { id: remote.id, name: remote.name } };
}

/**
 * Pull ONE remote file into Pufflet (`rclone cat` → existing encrypted
 * Telegram pipeline). The synchronous twin of a device upload: returns the
 * finished File row, and the UploadJob it went through is pollable like any
 * other upload.
 */
export async function ingestRemoteFile(
  ownerId: string,
  remoteId: string,
  rawPath: string,
  folderId: string | null,
  signal?: AbortSignal | null,
) {
  const remote = await assertRemote(remoteId, ownerId);
  const path = validateRemotePath(rawPath);
  if (!path) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  if (folderId) {
    const folder = await db.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.ownerId !== ownerId) throw new ServiceError("Folder not found", 404);
    if (folder.trashedAt) throw new ServiceError("Cannot import into a trashed folder", 400);
  }
  const { name, cfg } = await decryptRemote(remote);

  const stat = await statRemotePath(name, cfg, path, signal);
  if (!stat || stat.isDir) throw new ServiceError("Remote path not found", 404, "REMOTE_NOT_FOUND");
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new ServiceError(
      `“${stat.name}” is larger than this server's upload limit (${config.maxUploadMb} MB)`,
      413,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const mimeType = (stat.mimeType && stat.mimeType.length <= 100 ? stat.mimeType : null) ?? "application/octet-stream";
  const job = await createUploadJob(ownerId, { filename: stat.name, size: stat.size, mimeType, folderId }, "rclone");

  const cat = await openRemoteStream(name, cfg, path, signal);
  try {
    await cat.started; // fail fast on remote errors before touching the job
  } catch (err) {
    await db.uploadJob
      .update({ where: { id: job.id }, data: { status: "FAILED", error: rcloneSafeMessage(err).slice(0, 300) } })
      .catch(() => {});
    throw asServiceError(err, "Reading the file from the remote failed");
  }

  try {
    const file = await storeUploadStream(ownerId, job.id, cat.stream, { uploaderLabel: "rclone" });
    audit("rclone.ingest", ownerId, file.id, `← ${remote.name}:${path}`);
    return { file, uploadId: job.id };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw asServiceError(err, "Storing the imported file failed");
  }
}

// ---------------------------------------------------------------------------
// Sync jobs (folder push / pull)
// ---------------------------------------------------------------------------

const inFlight = new Map<string, AbortController>();

export function abortRcloneJob(jobId: string): void {
  inFlight.get(jobId)?.abort();
}

const JOB_STALE_MS = 90 * 60_000;

/** Jobs stuck RUNNING after a server restart can never finish — retire them. */
async function sweepStaleJobs(ownerId: string): Promise<void> {
  await db.rcloneJob
    .updateMany({
      where: {
        userId: ownerId,
        status: { in: ["QUEUED", "RUNNING"] },
        updatedAt: { lt: new Date(Date.now() - JOB_STALE_MS) },
      },
      data: { status: "FAILED", lastError: "Job interrupted (server restarted or timed out)" },
    })
    .catch(() => {});
}

export interface SyncRequest {
  remoteId?: unknown;
  kind?: unknown;
  remotePath?: unknown;
  folderId?: unknown;
}

export async function startSyncJob(ownerId: string, input: SyncRequest): Promise<JobRow> {
  if (typeof input.remoteId !== "string") throw new ServiceError("remoteId is required", 400);
  if (input.kind !== "push" && input.kind !== "pull") {
    throw new ServiceError("kind must be 'push' (Pufflet → remote) or 'pull' (remote → Pufflet)", 400);
  }
  if (!(RCLONE_JOB_KINDS as readonly string[]).includes(input.kind)) {
    throw new ServiceError("Unsupported sync kind", 400);
  }
  const remotePath = validateRemotePath(typeof input.remotePath === "string" ? input.remotePath : "");
  if (remotePath === null) throw new ServiceError("Invalid remote path", 400, "BAD_REMOTE_PATH");
  if (typeof input.folderId !== "string") throw new ServiceError("folderId is required", 400);

  const remote = await assertRemote(input.remoteId, ownerId);
  const folder = await db.folder.findUnique({ where: { id: input.folderId } });
  if (!folder || folder.ownerId !== ownerId) throw new ServiceError("Folder not found", 404);
  if (folder.trashedAt) throw new ServiceError("Cannot sync a trashed folder", 400);

  // One active sync per user keeps the Telegram rate budget predictable and
  // the progress counters meaningful.
  await sweepStaleJobs(ownerId);
  const active = await db.rcloneJob.count({ where: { userId: ownerId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active > 0) throw new ServiceError("Another sync is already running — wait for it to finish or cancel it", 409, "SYNC_ACTIVE");

  const job = await db.rcloneJob.create({
    data: {
      userId: ownerId,
      remoteId: remote.id,
      kind: input.kind,
      remotePath,
      folderId: folder.id,
      status: "QUEUED",
    },
  });
  audit("rclone.sync_start", ownerId, job.id, `${input.kind} ${remote.name}:${remotePath || "/"} ↔ folder`);
  void runJob(job.id).catch((err) => {
    console.error("[rclone] job runner crashed", job.id, err instanceof Error ? err.message : err);
  });
  return job;
}

export async function listJobs(ownerId: string, limit = 20) {
  const rows = await db.rcloneJob.findMany({
    where: { userId: ownerId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 50),
    include: { remote: { select: { id: true, name: true, type: true } } },
  });
  return rows.map((row) => toJobJson(row));
}

export type JobWithRemote = Omit<JobRow, "remote"> & { remote: { id: string; name: string; type: string } | null };

export async function getJob(ownerId: string, jobId: string): Promise<JobWithRemote> {
  const job = await db.rcloneJob.findUnique({
    where: { id: jobId },
    include: { remote: { select: { id: true, name: true, type: true } } },
  });
  if (!job || job.userId !== ownerId) throw new ServiceError("Job not found", 404);
  return job;
}

export async function cancelJob(ownerId: string, jobId: string): Promise<Omit<JobRow, "remote">> {
  const job = await getJob(ownerId, jobId);
  if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELED") {
    throw new ServiceError(`Job already ${job.status.toLowerCase()}`, 409);
  }
  if (job.status === "QUEUED") {
    // never started (or about to) — mark directly; the runner checks the row.
    const updated = await db.rcloneJob.update({ where: { id: job.id }, data: { status: "CANCELED", finishedAt: new Date() } });
    abortRcloneJob(job.id);
    audit("rclone.sync_cancel", ownerId, job.id, job.kind);
    return updated;
  }
  abortRcloneJob(job.id); // RUNNING: the runner observes the abort and marks CANCELED
  audit("rclone.sync_cancel", ownerId, job.id, job.kind);
  return job;
}

async function runJob(jobId: string): Promise<void> {
  const controller = new AbortController();
  inFlight.set(jobId, controller);
  try {
    const job = await db.rcloneJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === "CANCELED") return;
    const remote = await db.rcloneRemote.findUnique({ where: { id: job.remoteId } });
    if (!remote) {
      await db.rcloneJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: "Remote was deleted", finishedAt: new Date() } });
      return;
    }
    const { name, cfg } = await decryptRemote(remote);
    await db.rcloneJob.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date() } });

    const outcome =
      job.kind === "push"
        ? await runPush(job.id, job.userId, name, cfg, job.remotePath, job.folderId!, controller.signal)
        : await runPull(job.id, job.userId, name, cfg, job.remotePath, job.folderId!, controller.signal);

    const canceled = controller.signal.aborted;
    await db.rcloneJob
      .update({
        where: { id: job.id },
        data: {
          status: canceled ? "CANCELED" : "DONE",
          finishedAt: new Date(),
          ...(outcome.lastError ? { lastError: outcome.lastError.slice(0, 300) } : {}),
        },
      })
      .catch(() => {});
  } catch (err) {
    const message = rcloneSafeMessage(err);
    await db.rcloneJob
      .update({ where: { id: jobId }, data: { status: "FAILED", lastError: message.slice(0, 300), finishedAt: new Date() } })
      .catch(() => {});
    console.error("[rclone] job failed", jobId, message);
  } finally {
    inFlight.delete(jobId);
  }
}

interface JobOutcome {
  lastError?: string;
}

function joinRemotePath(base: string, rel: string): string {
  return base ? `${base}/${rel}` : rel;
}

/** push: Pufflet folder tree → remote (mkdir per dir, rcat per file). */
async function runPush(
  jobId: string,
  ownerId: string,
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  folderId: string,
  signal: AbortSignal,
): Promise<JobOutcome> {
  const folder = await db.folder.findUnique({ where: { id: folderId } });
  if (!folder || folder.ownerId !== ownerId) throw new ServiceError("Folder not found", 404);

  // Subtree folders (non-trashed) with their relative paths under the root.
  const all = await db.folder.findMany({ where: { ownerId, trashedAt: null }, select: { id: true, name: true, parentId: true } });
  const byId = new Map(all.map((f) => [f.id, f]));
  // descendantFolderIds only reads id/parentId — the narrowed select is safe.
  const subtree = descendantFolderIds(all as unknown as Folder[], folderId);
  const relOf = new Map<string, string>([[folderId, ""]]);
  for (const id of subtree) {
    if (id === folderId) continue;
    const chain: string[] = [];
    let cur = byId.get(id);
    let hops = 0;
    while (cur && cur.id !== folderId && hops < config.maxFolderDepth) {
      chain.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      hops++;
    }
    if (cur && cur.id === folderId) relOf.set(id, chain.join("/"));
  }
  const dirs = [...relOf.entries()].filter(([id, rel]) => id !== folderId && rel !== "").map(([, rel]) => rel);

  const files = await db.file.findMany({
    where: { ownerId, folderId: { in: [...subtree] }, trashedAt: null, status: "READY" },
    select: { id: true, name: true, size: true, folderId: true, tgFileId: true },
  });

  if (files.length > config.rcloneMaxSyncFiles) {
    throw new ServiceError(`This folder holds ${files.length} files — sync is capped at ${config.rcloneMaxSyncFiles} per job`, 400, "TOO_MANY");
  }

  await db.rcloneJob.update({ where: { id: jobId }, data: { totalFiles: files.length } });

  let lastError: string | undefined;
  let failed = 0;
  let done = 0;
  let bytes = BigInt(0);

  // Fail fast on bad credentials / missing root before touching files.
  if (remotePath) {
    await rcloneMkdir(remoteName, cfg, remotePath, signal);
  }

  // Dirs whose mkdir failed poison everything under them — their files are
  // counted failed ONCE in the file loop below (never double-counted).
  const poisoned: string[] = [];
  for (const rel of dirs) {
    if (signal.aborted) return { lastError };
    const target = validateRemotePath(joinRemotePath(remotePath, rel));
    if (!target) {
      poisoned.push(`${rel}/`);
      lastError = `Skipped unusable folder path: ${rel.slice(0, 80)}`;
      continue;
    }
    try {
      await rcloneMkdir(remoteName, cfg, target, signal);
    } catch (err) {
      if (signal.aborted) return { lastError };
      poisoned.push(`${rel}/`);
      lastError = `${rel.slice(0, 60)}: ${rcloneSafeMessage(err)}`;
    }
  }

  const tg = telegram();
  for (const file of files) {
    if (signal.aborted) break;
    const dirRel = folderRel(relOf, file.folderId, "");
    const target = validateRemotePath(joinRemotePath(remotePath, dirRel ? `${dirRel}/${file.name}` : file.name));
    if (!target || !file.tgFileId || poisoned.some((p) => target.startsWith(p))) {
      failed++;
      lastError = lastError ?? `Skipped ${file.name.slice(0, 60)} — its folder could not be created on the remote`;
      await db.rcloneJob.update({ where: { id: jobId }, data: { doneFiles: done, failed, bytes } }).catch(() => {});
      continue;
    }
    try {
      const { body, repaired } = await tg.openDownloadStream(file.tgFileId);
      if (repaired) {
        await repairFileReferences(file.id, repaired).catch(() => {});
      }
      const decoded = await decodeDownloadStream(body);
      await rcloneRcat(remoteName, cfg, target, decoded, signal);
      done++;
      bytes += BigInt(Math.max(0, file.size));
    } catch (err) {
      if (signal.aborted) break;
      failed++;
      lastError = `${file.name.slice(0, 60)}: ${rcloneSafeMessage(err)}`;
    }
    await db.rcloneJob
      .update({ where: { id: jobId }, data: { doneFiles: done, failed, bytes } })
      .catch(() => {});
  }
  return { lastError };
}

/** Relative path of a file's folder inside the subtree ("dir/sub"). */
function folderRel(relOf: Map<string, string>, folderId: string | null, fileName: string): string {
  if (!folderId) return fileName;
  const rel = relOf.get(folderId);
  if (rel === undefined) return "";
  return rel ? `${rel}/${fileName}` : fileName;
}

/** pull: remote tree → Pufflet (lsjson -R, ensureFolderPaths, cat per file). */
async function runPull(
  jobId: string,
  ownerId: string,
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  folderId: string,
  signal: AbortSignal,
): Promise<JobOutcome> {
  const listing = await lsJson(remoteName, cfg, remotePath, { recursive: true, signal });
  const dirs: string[] = [];
  const files: RcloneEntry[] = [];
  for (const entry of listing) {
    if (entry.isDir) dirs.push(entry.path);
    else files.push(entry);
  }
  if (files.length > config.rcloneMaxSyncFiles) {
    throw new ServiceError(`The remote folder holds ${files.length} files — sync is capped at ${config.rcloneMaxSyncFiles} per job`, 400, "TOO_MANY");
  }

  // Mirror the directory structure (find-or-create, Drive semantics).
  let folderMap: Record<string, string> = {};
  if (dirs.length) {
    const ensured = await ensureFolderPaths(ownerId, folderId, dirs);
    folderMap = ensured.folders;
  }

  await db.rcloneJob.update({ where: { id: jobId }, data: { totalFiles: files.length } });

  let lastError: string | undefined;
  let failed = 0;
  let skipped = 0;
  let done = 0;
  let bytes = BigInt(0);

  for (const entry of files) {
    if (signal.aborted) break;
    const segs = entry.path.split("/");
    const fileName = segs[segs.length - 1] || entry.name;
    const dirRel = segs.slice(0, -1).join("/");
    const targetFolderId = dirRel ? folderMap[dirRel] : folderId;
    if (entry.size > MAX_UPLOAD_BYTES) {
      skipped++;
      lastError = `${fileName.slice(0, 60)}: larger than the ${config.maxUploadMb} MB upload limit`;
      continue;
    }
    if (!targetFolderId) {
      skipped++;
      lastError = `${fileName.slice(0, 60)}: its folder could not be created`;
      continue;
    }
    try {
      const mimeType = (entry.mimeType && entry.mimeType.length <= 100 ? entry.mimeType : null) ?? "application/octet-stream";
      const { createUploadJob, storeUploadStream } = await import("@/lib/files");
      const job = await createUploadJob(ownerId, { filename: fileName, size: entry.size, mimeType, folderId: targetFolderId }, "rclone");
      const cat = await openRemoteStream(remoteName, cfg, joinRemotePath(remotePath, entry.path), signal);
      try {
        await cat.started;
      } catch (err) {
        await db.uploadJob
          .update({ where: { id: job.id }, data: { status: "FAILED", error: rcloneSafeMessage(err).slice(0, 300) } })
          .catch(() => {});
        throw err;
      }
      const file = await storeUploadStream(ownerId, job.id, cat.stream, { uploaderLabel: "rclone" });
      done++;
      bytes += BigInt(file.size);
    } catch (err) {
      if (signal.aborted) break;
      failed++;
      lastError = `${fileName.slice(0, 60)}: ${rcloneSafeMessage(err)}`;
    }
    await db.rcloneJob
      .update({ where: { id: jobId }, data: { doneFiles: done, failed, skipped, bytes } })
      .catch(() => {});
  }
  return { lastError };
}

// ---------------------------------------------------------------------------
// Status (availability probe, cached)
// ---------------------------------------------------------------------------

let versionCache: { banner: string; at: number } | null = null;

export async function rcloneStatus() {
  const enabled = config.rcloneEnabled;
  const { missing } = rcloneBinary();
  if (!enabled || missing) {
    return { enabled, binaryMissing: missing, version: null, ok: false };
  }
  if (!versionCache || Date.now() - versionCache.at > 60_000) {
    try {
      const banner = await rcloneVersion();
      versionCache = { banner, at: Date.now() };
    } catch (err) {
      versionCache = { banner: "", at: Date.now() - 55_000 }; // retry sooner than a full TTL
      console.error("[rclone] version probe failed:", err instanceof Error ? err.message : err);
      return { enabled, binaryMissing: false, version: null, ok: false };
    }
  }
  return { enabled, binaryMissing: false, version: versionCache.banner || null, ok: versionCache.banner.length > 0 };
}
