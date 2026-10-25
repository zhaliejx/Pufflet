// State backup — makes Pufflet self-healing on ephemeral hosts. ----------------
//
// The metadata DB (SQLite/Postgres) holds the *index* of your files; the file
// bytes live in your Telegram storage chat. Free app hosts (Hugging Face
// Spaces, Render free tier, Koyeb, ...) wipe the local disk whenever the
// container restarts — which would orphan every Telegram message.
//
// Solution: serialize the index into a JSON snapshot and keep it as a PINNED
// DOCUMENT in the very same storage chat (one message, media-edited in place
// on every flush — no chat spam). On boot, a fresh container finds that pinned
// snapshot via getChat(), downloads it, and restores the DB automatically.
//
//   - The Bot API has no "list chat history" method, but getChat() DOES return
//     the most recent pinned message — that is why the snapshot must be pinned.
//   - The snapshot contains password hashes and API-key hashes, so the storage
//     chat must stay private (it already must: it holds all your files).
//   - Sessions, upload jobs, and audit events are deliberately NOT part of the
//     snapshot: sessions are transient, jobs are resumable, audit is noise.
//
// Vercel note: serverless cold starts make auto-flush unreliable there and a
// hosted Postgres already persists — set STATE_BACKUP="false" on Vercel.

import { db } from "@/lib/db";
import { config, isTelegramConfigured } from "@/lib/config";
import { telegram, TelegramError } from "@/lib/telegram";
import type { Prisma } from "@prisma/client";

export const SNAPSHOT_VERSION = 3;
export const LEGACY_SNAPSHOT_VERSIONS = [1, 2] as const; // still restorable (pre-vault / pre-share snapshots)
export const STATE_BACKUP_MARKER = "pufflet-state-backup.json";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024; // safety cap while restoring

// --- checkpoint history (previous good backups) ------------------------------
// The pinned message is the HOT slot: edited in place on every flush. Every
// CHECKPOINT_INTERVAL_MS a fresh message is additionally sent as a COLD
// checkpoint, so the previous good snapshot survives a bad hot edit. Checkpoint
// message ids (+ file ids) are recorded in the Setting table — they are only
// discoverable while the DB lives, which is exactly the failure mode they
// cover (bad/corrupt hot snapshot with an intact database).
export const CHECKPOINT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const MAX_CHECKPOINTS = 3;
export const CHECKPOINTS_SETTING_KEY = "stateBackup.checkpoints";
export const HOT_MESSAGE_SETTING_KEY = "stateBackup.messageId";

export interface CheckpointEntry {
  messageId: string;
  fileId: string;
  at: string; // ISO timestamp of when the checkpoint was taken
  size: number;
  files: number;
  users: number;
}

/** Safely parse the stored checkpoint ring; garbage in -> empty list out. */
export function parseCheckpoints(raw: string | null | undefined): CheckpointEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is CheckpointEntry =>
        !!c &&
        typeof c === "object" &&
        typeof (c as CheckpointEntry).messageId === "string" &&
        typeof (c as CheckpointEntry).fileId === "string" &&
        typeof (c as CheckpointEntry).at === "string",
    );
  } catch {
    return [];
  }
}

/** Insert a checkpoint (newest first), dedupe by messageId, trim the ring. */
export function pushCheckpoint(
  list: CheckpointEntry[],
  entry: CheckpointEntry,
  max: number = MAX_CHECKPOINTS,
): CheckpointEntry[] {
  const next = [entry, ...list.filter((c) => c.messageId !== entry.messageId)];
  return next.slice(0, Math.max(1, max));
}

/** True when a fresh cold checkpoint is due (none yet, or the newest expired). */
export function shouldCheckpoint(
  list: CheckpointEntry[],
  now: number = Date.now(),
  intervalMs: number = CHECKPOINT_INTERVAL_MS,
): boolean {
  if (list.length === 0) return true;
  const newest = list.reduce((acc, c) => Math.max(acc, new Date(c.at).getTime() || 0), 0);
  return now - newest >= intervalMs;
}

/** Refuse to overwrite a good backup with an empty index (a wiped/failed DB
 *  must never destroy the only copy of the index in the storage chat). */
export function shouldRefuseEmptySnapshot(users: number, hasPreviousGood: boolean): boolean {
  return users === 0 && hasPreviousGood;
}

/** Verify an upload actually transferred the whole snapshot: the Bot API
 *  reports the stored document size; a mismatch means the bytes did not
 *  arrive intact and the flush must be treated as FAILED (the previous good
 *  snapshot stays untouched because editMessageMedia is atomic). A reported
 *  size of 0 means "unknown" — nothing to compare. */
export function verifySnapshotUpload(localBytes: number, reportedSize: number | null | undefined): boolean {
  return !reportedSize || reportedSize === localBytes;
}

/** Serialize, then re-parse and re-serialize to prove the snapshot survives a
 *  round-trip — a corrupt build must never replace the pinned good copy. */
export function serializeVerifiedSnapshot(data: SnapshotData): string {
  const text = JSON.stringify(data);
  const reparsed = parseSnapshot(text); // throws on structural problems
  const again = JSON.stringify(reparsed);
  parseSnapshot(again); // and once more for good measure
  return text;
}

// --------------------------------------------------------------------------
// Serializable snapshot types (dates as ISO strings; JSON-safe by design)
// --------------------------------------------------------------------------

export interface SnapshotUser {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  role: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotFolder {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotFile {
  id: string;
  name: string;
  normalizedName: string;
  size: number;
  mimeType: string;
  status: string;
  starred: boolean;
  ownerId: string;
  folderId: string | null;
  trashedAt: string | null;
  sha256: string | null;
  uploaderLabel: string | null;
  tgChatId: string | null;
  tgMessageId: string | null;
  tgFileId: string | null;
  tgFileUniqueId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotApiKey {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  userId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Generic key/value rows — carries the vault master key so a self-healed
 *  database can still decrypt vault containers. */
export interface SnapshotSetting {
  key: string;
  value: string;
}

/** Public share links (v3+). Tokens ride in the snapshot so links keep
 *  working after a self-heal on an ephemeral host. */
export interface SnapshotShareLink {
  id: string;
  token: string;
  fileId: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  downloads: number;
  lastDownloadAt: string | null;
}

export interface SnapshotData {
  version: number;
  exportedAt: string;
  counts: { users: number; folders: number; files: number; apiKeys: number; shareLinks?: number };
  users: SnapshotUser[];
  folders: SnapshotFolder[];
  files: SnapshotFile[];
  apiKeys: SnapshotApiKey[];
  /** v2+. v1 snapshots have no settings (empty array after parse). */
  settings: SnapshotSetting[];
  /** v3+. v1/v2 snapshots have no share links (empty array after parse). */
  shareLinks: SnapshotShareLink[];
}

// --------------------------------------------------------------------------
// Pure snapshot helpers (unit-tested without a DB)
// --------------------------------------------------------------------------

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

export function serializeSnapshot(data: SnapshotData): string {
  return JSON.stringify(data);
}

export function parseSnapshot(text: string): SnapshotData {
  const raw = JSON.parse(text) as Partial<SnapshotData> | null;
  if (!raw || typeof raw !== "object") throw new Error("Snapshot is not an object");
  const version = raw.version as number;
  const isCurrent = version === SNAPSHOT_VERSION;
  const isLegacy = (LEGACY_SNAPSHOT_VERSIONS as readonly number[]).includes(version);
  if (!isCurrent && !isLegacy) {
    throw new Error(`Unsupported snapshot version: ${String(version)}`);
  }
  for (const key of ["users", "folders", "files", "apiKeys"] as const) {
    if (!Array.isArray(raw[key])) throw new Error(`Snapshot field "${key}" is missing`);
  }
  return {
    version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    counts: raw.counts ?? {
      users: raw.users!.length,
      folders: raw.folders!.length,
      files: raw.files!.length,
      apiKeys: raw.apiKeys!.length,
      shareLinks: raw.shareLinks?.length ?? 0,
    },
    users: raw.users as SnapshotUser[],
    folders: raw.folders as SnapshotFolder[],
    files: raw.files as SnapshotFile[],
    apiKeys: raw.apiKeys as SnapshotApiKey[],
    // v1 snapshots predate the vault / Setting table: no key material in them.
    // A fresh key is generated on the first post-restore upload, and the next
    // flush persists it as v2+.
    settings: version >= 2 && Array.isArray(raw.settings) ? (raw.settings as SnapshotSetting[]) : [],
    // v3+: public share links. Older snapshots restore with none; owners can
    // recreate links (or accept that pre-v3 shares died with the old DB).
    shareLinks: Array.isArray(raw.shareLinks) ? (raw.shareLinks as SnapshotShareLink[]) : [],
  };
}

/**
 * Restore the snapshot inside a transaction. Keeps all row ids so Telegram
 * references (message/file ids) stay valid. Folder self-references are linked
 * in a second pass because every row must exist before a parentId points at it.
 *
 * Defensive: rows whose relations point OUTSIDE the snapshot (a torn read
 * during a concurrent mutation, or a hand-edited file) are pruned instead of
 * crashing the whole restore — a partially-restorable snapshot restores the
 * rows it can and logs what it dropped, never throwing FK violations.
 */
export async function applySnapshotData(tx: Prisma.TransactionClient, raw: SnapshotData): Promise<void> {
  const pruned = pruneDanglingRefs(raw);
  const data = pruned.data;
  if (pruned.droppedTotal > 0) {
    console.log(
      `[state-backup] pruned dangling rows from snapshot: ` +
        `${pruned.dropped.files} file(s), ${pruned.dropped.folders} folder(s), ${pruned.dropped.apiKeys} API key(s), ${pruned.dropped.shareLinks} share link(s)`,
    );
  }
  // Wipe (children first; folders self-reference so null the pointer first).
  await tx.auditEvent.deleteMany({});
  await tx.uploadJob.deleteMany({});
  await tx.session.deleteMany({});
  await tx.shareLink.deleteMany({});
  await tx.apiKey.deleteMany({});
  await tx.file.deleteMany({});
  await tx.folder.updateMany({ data: { parentId: null } });
  await tx.folder.deleteMany({});
  await tx.user.deleteMany({});
  await tx.setting.deleteMany({});

  for (const u of data.users) {
    await tx.user.create({
      data: {
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.passwordHash,
        role: u.role,
        mustChangePassword: u.mustChangePassword,
        createdAt: new Date(u.createdAt),
        updatedAt: new Date(u.updatedAt),
      },
    });
  }

  for (const f of data.folders) {
    await tx.folder.create({
      data: {
        id: f.id,
        name: f.name,
        ownerId: f.ownerId,
        trashedAt: f.trashedAt ? new Date(f.trashedAt) : null,
        createdAt: new Date(f.createdAt),
        updatedAt: new Date(f.updatedAt),
      },
    });
  }
  for (const f of data.folders) {
    if (f.parentId) {
      await tx.folder.update({ where: { id: f.id }, data: { parentId: f.parentId } });
    }
  }

  for (const f of data.files) {
    await tx.file.create({
      data: {
        id: f.id,
        name: f.name,
        normalizedName: f.normalizedName,
        size: f.size,
        mimeType: f.mimeType,
        status: f.status,
        starred: f.starred,
        ownerId: f.ownerId,
        folderId: f.folderId,
        trashedAt: f.trashedAt ? new Date(f.trashedAt) : null,
        sha256: f.sha256,
        uploaderLabel: f.uploaderLabel,
        tgChatId: f.tgChatId,
        tgMessageId: f.tgMessageId,
        tgFileId: f.tgFileId,
        tgFileUniqueId: f.tgFileUniqueId,
        createdAt: new Date(f.createdAt),
        updatedAt: new Date(f.updatedAt),
      },
    });
  }

  for (const k of data.apiKeys) {
    await tx.apiKey.create({
      data: {
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        hash: k.hash,
        scopes: k.scopes,
        userId: k.userId,
        expiresAt: k.expiresAt ? new Date(k.expiresAt) : null,
        lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt) : null,
        revokedAt: k.revokedAt ? new Date(k.revokedAt) : null,
        createdAt: new Date(k.createdAt),
      },
    });
  }

  // Settings last (v2+): includes the vault master key. Restoring it is what
  // keeps files uploaded under that key decryptable after a self-heal.
  for (const s of data.settings ?? []) {
    await tx.setting.create({ data: { key: s.key, value: s.value } });
  }

  // Public share links (v3+): tokens are restored verbatim so previously
  // handed-out /s/<token> URLs keep working after a self-heal.
  for (const l of data.shareLinks ?? []) {
    await tx.shareLink.create({
      data: {
        id: l.id,
        token: l.token,
        fileId: l.fileId,
        createdBy: l.createdBy,
        createdAt: new Date(l.createdAt),
        revokedAt: l.revokedAt ? new Date(l.revokedAt) : null,
        expiresAt: l.expiresAt ? new Date(l.expiresAt) : null,
        downloads: l.downloads ?? 0,
        lastDownloadAt: l.lastDownloadAt ? new Date(l.lastDownloadAt) : null,
      },
    });
  }
}

// --------------------------------------------------------------------------
// Snapshot sanitation (pure, unit-tested)
// --------------------------------------------------------------------------

export interface PruneResult {
  data: SnapshotData;
  dropped: { files: number; folders: number; apiKeys: number; shareLinks: number };
  droppedTotal: number;
}

/**
 * Drop snapshot rows whose required relations are missing from the snapshot:
 *   - folders whose owner is absent (or whose whole ancestor chain is absent)
 *   - files whose owner or folder is absent
 *   - API keys whose user is absent
 *   - share links whose file or creator is absent
 * This makes restores total: a torn snapshot (built while a concurrent move
 * or upload was in flight) restores cleanly instead of dying on an FK violation.
 */
export function pruneDanglingRefs(input: SnapshotData): PruneResult {
  const userIds = new Set(input.users.map((u) => u.id));

  // Fixpoint: a folder survives when its owner survives and its parent is
  // also surviving (or it has none). Handles arbitrarily deep chains.
  const keptFolders = new Map<string, SnapshotFolder>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of input.folders) {
      if (keptFolders.has(f.id)) continue;
      if (!userIds.has(f.ownerId)) continue;
      if (f.parentId && !keptFolders.has(f.parentId)) continue;
      keptFolders.set(f.id, f);
      changed = true;
    }
  }

  const keptFiles = input.files.filter(
    (f) => userIds.has(f.ownerId) && (!f.folderId || keptFolders.has(f.folderId)),
  );
  const fileIds = new Set(keptFiles.map((f) => f.id));
  const keptKeys = input.apiKeys.filter((k) => userIds.has(k.userId));
  const keptLinks = input.shareLinks.filter((l) => fileIds.has(l.fileId) && userIds.has(l.createdBy));

  const dropped = {
    files: input.files.length - keptFiles.length,
    folders: input.folders.length - keptFolders.size,
    apiKeys: input.apiKeys.length - keptKeys.length,
    shareLinks: input.shareLinks.length - keptLinks.length,
  };
  const droppedTotal = dropped.files + dropped.folders + dropped.apiKeys + dropped.shareLinks;
  if (droppedTotal === 0) return { data: input, dropped, droppedTotal: 0 };

  return {
    data: {
      ...input,
      folders: [...keptFolders.values()],
      files: keptFiles,
      apiKeys: keptKeys,
      shareLinks: keptLinks,
      counts: {
        ...input.counts,
        folders: keptFolders.size,
        files: keptFiles.length,
        apiKeys: keptKeys.length,
        shareLinks: keptLinks.length,
      },
    },
    dropped,
    droppedTotal,
  };
}

// --------------------------------------------------------------------------
// Live backup engine (process-wide, guarded against hot reloads)
// --------------------------------------------------------------------------

let dirty = false;
let flushing = false;
let lastMessageId: string | null = null;
let pinConfirmed = false;
let lastBackupAt: string | null = null;
let lastBackupSize = 0;
let lastError: string | null = null;
let lastGoodUserCount: number | null = null; // null = we have never seen a good snapshot
let checkpoints: CheckpointEntry[] = [];
let checkpointsLoaded = false;

async function loadCheckpoints(): Promise<CheckpointEntry[]> {
  if (checkpointsLoaded) return checkpoints;
  try {
    const row = await db.setting.findUnique({ where: { key: CHECKPOINTS_SETTING_KEY } });
    checkpoints = parseCheckpoints(row?.value);
  } catch {
    checkpoints = [];
  }
  checkpointsLoaded = true;
  return checkpoints;
}

async function saveCheckpoints(list: CheckpointEntry[]): Promise<void> {
  checkpoints = list;
  await db.setting.upsert({
    where: { key: CHECKPOINTS_SETTING_KEY },
    update: { value: JSON.stringify(list) },
    create: { key: CHECKPOINTS_SETTING_KEY, value: JSON.stringify(list) },
  });
}

async function rememberHotMessage(messageId: string): Promise<void> {
  try {
    await db.setting.upsert({
      where: { key: HOT_MESSAGE_SETTING_KEY },
      update: { value: messageId },
      create: { key: HOT_MESSAGE_SETTING_KEY, value: messageId },
    });
  } catch {
    // best-effort — the pinned message is the primary pointer
  }
}

/** Drop all in-memory upload state (used after a restore so the next flush
 *  re-discovers the pin instead of editing a message that may be gone). */
export function resetBackupMemory(): void {
  lastMessageId = null;
  pinConfirmed = false;
  lastGoodUserCount = null;
  checkpointsLoaded = false;
}

type Globals = {
  __puffletStateBoot?: Promise<void>;
  __puffletStateBackupTimer?: ReturnType<typeof setInterval>;
};
const g = globalThis as unknown as Globals;

/** Mark the index as changed so the next auto-flush uploads a new snapshot. */
export function markStateDirty(): void {
  dirty = true;
}

export function backupStatus() {
  return {
    enabled: config.stateBackupEnabled,
    telegramConfigured: isTelegramConfigured(),
    intervalMs: config.stateBackupIntervalMs,
    pendingChanges: dirty,
    lastBackupAt,
    lastBackupSize,
    lastError,
    checkpoints: checkpoints.length,
    lastCheckpointAt: checkpoints[0]?.at ?? null,
  };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readStreamCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) throw new Error("Snapshot exceeds the safety size cap");
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

async function buildSnapshotData(): Promise<SnapshotData> {
  // One transaction: a consistent read of all six tables. Without it, a move
  // or upload racing the snapshot could embed a file whose folder row is
  // missing — an FK violation that would crash every future restore of that
  // snapshot. (Residual races are still covered by pruneDanglingRefs.)
  const [users, folders, files, apiKeys, settings, shareLinks] = await db.$transaction(
    [
      db.user.findMany({ orderBy: { createdAt: "asc" } }),
      db.folder.findMany({ orderBy: { createdAt: "asc" } }),
      db.file.findMany({ orderBy: { createdAt: "asc" } }),
      db.apiKey.findMany({ orderBy: { createdAt: "asc" } }),
      db.setting.findMany({ orderBy: { key: "asc" } }),
      db.shareLink.findMany({ orderBy: { createdAt: "asc" } }),
    ],
  );
  const data: SnapshotData = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      users: users.length,
      folders: folders.length,
      files: files.length,
      apiKeys: apiKeys.length,
      shareLinks: shareLinks.length,
    },
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      passwordHash: u.passwordHash,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
      createdAt: iso(u.createdAt)!,
      updatedAt: iso(u.updatedAt)!,
    })),
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      ownerId: f.ownerId,
      parentId: f.parentId,
      trashedAt: iso(f.trashedAt),
      createdAt: iso(f.createdAt)!,
      updatedAt: iso(f.updatedAt)!,
    })),
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      normalizedName: f.normalizedName,
      size: f.size,
      mimeType: f.mimeType,
      status: f.status,
      starred: f.starred,
      ownerId: f.ownerId,
      folderId: f.folderId,
      trashedAt: iso(f.trashedAt),
      sha256: f.sha256,
      uploaderLabel: f.uploaderLabel,
      tgChatId: f.tgChatId,
      tgMessageId: f.tgMessageId,
      tgFileId: f.tgFileId,
      tgFileUniqueId: f.tgFileUniqueId,
      createdAt: iso(f.createdAt)!,
      updatedAt: iso(f.updatedAt)!,
    })),
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      hash: k.hash,
      scopes: k.scopes,
      userId: k.userId,
      expiresAt: iso(k.expiresAt),
      lastUsedAt: iso(k.lastUsedAt),
      revokedAt: iso(k.revokedAt),
      createdAt: iso(k.createdAt)!,
    })),
    settings: settings.map((s) => ({ key: s.key, value: s.value })),
    shareLinks: shareLinks.map((l) => ({
      id: l.id,
      token: l.token,
      fileId: l.fileId,
      createdBy: l.createdBy,
      createdAt: iso(l.createdAt)!,
      revokedAt: iso(l.revokedAt),
      expiresAt: iso(l.expiresAt),
      downloads: l.downloads,
      lastDownloadAt: iso(l.lastDownloadAt),
    })),
  };
  return data;
}

/**
 * Upload the current snapshot to the storage chat as a pinned document.
 * Reuses the same message via editMessageMedia so repeated flushes never
 * flood the chat; if the message vanished (user deleted it), a fresh one is
 * sent and pinned again. Pinning is what lets a FRESH container discover the
 * snapshot on boot.
 *
 * Failure philosophy: a failed or unverifiable flush NEVER replaces the last
 * known-good snapshot (editMessageMedia is atomic and the guards below refuse
 * empty/corrupt builds before any upload), failures are logged server-side,
 * and transient Telegram faults get one bounded retry before reporting.
 */
export async function flushStateBackup(): Promise<{ ok: boolean; bytes?: number; error?: string; checkpointTaken?: boolean }> {
  if (!config.stateBackupEnabled) {
    return { ok: false, error: "State backup is disabled (STATE_BACKUP=false)" };
  }
  if (!isTelegramConfigured()) {
    return { ok: false, error: "Telegram storage is not configured" };
  }
  if (flushing) return { ok: false, error: "A backup is already in progress" };
  flushing = true;
  try {
    const data = await buildSnapshotData();

    // SAFETY GUARD 1 — never overwrite a good backup with an empty index.
    // A wiped or failed database must not destroy the only copy of the index
    // that lives in the storage chat. (Users can never legitimately reach 0:
    // the owner cannot delete their own account.) Hardened: when the pinned
    // snapshot's existence is UNKNOWN (Telegram probe failed), assume a good
    // backup is present and refuse — only a definitive "no pin found" allows
    // a 0-user snapshot through.
    const pinState = lastMessageId ? ("found" as const) : await probePinnedSnapshot();
    const previousGood = lastGoodUserCount ?? (pinState === "found" ? 1 : null);
    if (shouldRefuseEmptySnapshot(data.users.length, previousGood !== null) || (data.users.length === 0 && pinState === "unknown")) {
      lastError =
        "Refusing to overwrite the last good backup with an EMPTY index (0 users). If this is intentional, delete the pinned pufflet-state-backup.json message first.";
      console.error("[state-backup]", lastError);
      return { ok: false, error: lastError };
    }

    // SAFETY GUARD 2 — verify the snapshot round-trips before touching the
    // chat; a corrupt build must never replace the pinned good copy.
    let text: string;
    try {
      text = serializeVerifiedSnapshot(data);
    } catch (err) {
      lastError = `Snapshot failed verification, upload skipped: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[state-backup]", lastError);
      return { ok: false, error: lastError };
    }
    const bytes = new TextEncoder().encode(text);
    const tg = telegram();
    const chatId = config.telegramChatId;

    // Resolve the reuse target: in-memory pointer first, then the pinned doc.
    if (!lastMessageId) {
      await discoverPinnedMessage();
    }

    /** One bounded retry for transient Telegram faults (429/5xx/network). */
    async function uploadOnce<T>(send: () => Promise<T>): Promise<T> {
      try {
        return await send();
      } catch (err) {
        const retryable = !(err instanceof TelegramError) || err.retryable;
        if (!retryable) throw err;
        console.warn("[state-backup] transient upload failure, retrying once:", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 1_500));
        return send();
      }
    }

    let uploadedSize: number | null = null;
    if (lastMessageId && tg.editMessageDocument) {
      try {
        const edited = await uploadOnce(() =>
          tg.editMessageDocument!(chatId, lastMessageId!, STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes)),
        );
        uploadedSize = edited.size;
      } catch {
        // The message was probably deleted (or the pin moved) — re-discover
        // once before falling back to a fresh send, so we do not orphan the
        // good copy while a recoverable pointer exists.
        lastMessageId = null;
        pinConfirmed = false;
        await discoverPinnedMessage();
        if (lastMessageId && tg.editMessageDocument) {
          try {
            const edited = await uploadOnce(() =>
              tg.editMessageDocument!(chatId, lastMessageId!, STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes)),
            );
            uploadedSize = edited.size;
          } catch {
            lastMessageId = null;
            pinConfirmed = false;
          }
        }
      }
    }
    if (uploadedSize === null) {
      const stored = await uploadOnce(() => tg.sendDocument(STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes)));
      uploadedSize = stored.size;
      lastMessageId = stored.messageId;
      pinConfirmed = false;
    }

    // SAFETY GUARD 3 — the storage server must have received the WHOLE
    // snapshot. A truncated upload must not be reported as success.
    if (!verifySnapshotUpload(bytes.byteLength, uploadedSize)) {
      lastError = `Snapshot upload incomplete (Telegram received ${uploadedSize} of ${bytes.byteLength} bytes) — previous backup left untouched, will retry.`;
      console.error("[state-backup]", lastError);
      dirty = true;
      return { ok: false, error: lastError };
    }

    if (!pinConfirmed && lastMessageId && tg.pinChatMessage) {
      try {
        await tg.pinChatMessage(chatId, lastMessageId);
        pinConfirmed = true;
      } catch (err) {
        lastError =
          "Snapshot uploaded but NOT pinned — grant the bot the 'pin messages' admin right so fresh containers can find it. Will retry.";
        console.error("[state-backup]", lastError, err instanceof Error ? err.message : err);
        lastBackupAt = new Date().toISOString();
        lastBackupSize = bytes.byteLength;
        lastGoodUserCount = data.users.length;
        dirty = true; // retry (edit + pin) on the next flush
        return { ok: false, error: `${lastError} (${err instanceof Error ? err.message : String(err)})` };
      }
    }

    // Hot message pointer is durable now — remember it in the DB so a restore
    // can find the snapshot even if the pin is later lost.
    if (lastMessageId) void rememberHotMessage(lastMessageId).catch(() => {});

    dirty = false;
    lastError = null;
    lastBackupAt = new Date().toISOString();
    lastBackupSize = bytes.byteLength;
    lastGoodUserCount = data.users.length;

    // COLD checkpoint: every CHECKPOINT_INTERVAL_MS, send a fresh message so
    // the previous good snapshot survives a bad hot edit. Best-effort — a
    // failed checkpoint never marks the backup itself as failed.
    let checkpointTaken = false;
    try {
      const list = await loadCheckpoints();
      if (shouldCheckpoint(list)) {
        const stored = await uploadOnce(() => tg.sendDocument(STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes)));
        if (verifySnapshotUpload(bytes.byteLength, stored.size)) {
          const entry: CheckpointEntry = {
            messageId: stored.messageId,
            fileId: stored.fileId,
            at: new Date().toISOString(),
            size: bytes.byteLength,
            files: data.counts.files,
            users: data.counts.users,
          };
          await saveCheckpoints(pushCheckpoint(list, entry));
          checkpointTaken = true;
          console.log(
            `[state-backup] cold checkpoint stored: ${entry.files} file(s), ${entry.users} user(s), ${entry.size} bytes`,
          );
        } else {
          console.error("[state-backup] checkpoint upload incomplete — ring not advanced (hot backup is still good)");
        }
      }
    } catch (err) {
      console.error("[state-backup] checkpoint failed (hot backup is still good):", err instanceof Error ? err.message : err);
    }

    return { ok: true, bytes: bytes.byteLength, checkpointTaken };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    dirty = true;
    console.error("[state-backup] flush failed (previous snapshot untouched):", lastError);
    return { ok: false, error: lastError };
  } finally {
    flushing = false;
  }
}

/** Best-effort discovery of the pinned snapshot message. Returns true when a
 *  Pufflet snapshot pin is (now) known in memory. */
async function discoverPinnedMessage(): Promise<boolean> {
  const tg = telegram();
  if (!tg.getChatPinnedDocument) return false;
  try {
    const pinned = await tg.getChatPinnedDocument(config.telegramChatId);
    if (pinned && pinned.fileName === STATE_BACKUP_MARKER) {
      lastMessageId = pinned.messageId;
      pinConfirmed = true;
      return true;
    }
  } catch {
    // Discovery is best-effort; a fresh send still works.
  }
  return false;
}

/**
 * Probe whether a Pufflet snapshot pin exists, distinguishing "definitely
 * absent" from "could not tell" (network/API failure). The empty-index guard
 * uses this: when unknown, flushing an empty snapshot is refused.
 */
async function probePinnedSnapshot(): Promise<"found" | "absent" | "unknown"> {
  const tg = telegram();
  if (!tg.getChatPinnedDocument) return "unknown";
  try {
    const pinned = await tg.getChatPinnedDocument(config.telegramChatId);
    return pinned && pinned.fileName === STATE_BACKUP_MARKER ? "found" : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Boot-time restore: when the DB has no users (fresh container/disk) and a
 * pinned Pufflet snapshot exists in the storage chat, restore it. If the
 * pinned snapshot cannot be restored, fall back to the newest recorded cold
 * checkpoint (needs the Setting row, i.e. an intact DB). Safe to call
 * repeatedly — the whole boot sequence runs once per process.
 */
export async function restoreIfEmpty(): Promise<{ restored: boolean; reason?: string }> {
  const userCount = await db.user.count();
  if (userCount > 0) return { restored: false, reason: "database not empty" };

  const tg = telegram(); // throws when unconfigured — callers guard
  if (!tg.getChatPinnedDocument) return { restored: false, reason: "adapter lacks pinned-document support" };

  const pinned = await tg.getChatPinnedDocument(config.telegramChatId);
  if (pinned && pinned.fileName === STATE_BACKUP_MARKER) {
    try {
      const data = await downloadAndParse(pinned.fileId);
      await applyInTransaction(data);
      logRestored(data, "pinned");
      return { restored: true };
    } catch (err) {
      console.error("[state-backup] pinned snapshot restore failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fallback: newest cold checkpoint recorded in the Setting table.
  const list = await loadCheckpoints();
  for (const cp of list) {
    try {
      const data = await downloadAndParse(cp.fileId);
      await applyInTransaction(data);
      logRestored(data, `checkpoint ${cp.messageId} (${cp.at})`);
      return { restored: true };
    } catch (err) {
      console.error(`[state-backup] checkpoint ${cp.messageId} restore failed:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    restored: false,
    reason: pinned
      ? "snapshot download/parse failed and no usable checkpoint remained"
      : "no Pufflet snapshot pinned in the storage chat",
  };
}

async function downloadAndParse(fileId: string): Promise<SnapshotData> {
  const { body } = await telegram().openDownloadStream(fileId);
  const text = await readStreamCapped(body, MAX_SNAPSHOT_BYTES);
  return parseSnapshot(text);
}

async function applyInTransaction(data: SnapshotData): Promise<void> {
  await db.$transaction((tx) => applySnapshotData(tx, data), { timeout: 60_000 });
  // The DB now equals the snapshot: refresh in-memory state so the next
  // flush re-discovers the pin instead of editing a stale message pointer.
  resetBackupMemory();
  lastGoodUserCount = data.counts.users;
  lastBackupAt = data.exportedAt;
}

function logRestored(data: SnapshotData, source: string): void {
  console.log(
    `[state-backup] restored snapshot from ${source} (exported ${data.exportedAt}): ` +
      `${data.counts.users} user(s), ${data.counts.folders} folder(s), ${data.counts.files} file(s), ${data.counts.apiKeys} API key(s)` +
      (data.settings.length ? `, ${data.settings.length} setting(s) incl. vault key` : "") +
      (data.shareLinks.length ? `, ${data.shareLinks.length} share link(s)` : ""),
  );
}

/**
 * Explicit restore over the CURRENT database (Settings -> Data safety).
 * source "pinned" restores the hot snapshot; source "checkpoint" restores a
 * recorded cold checkpoint by messageId (validated against the stored ring —
 * arbitrary Telegram message ids are never accepted).
 */
export async function restoreFromBackup(
  source: "pinned" | "checkpoint",
  messageId?: string,
): Promise<{ ok: true; counts: SnapshotData["counts"]; exportedAt: string } | { ok: false; error: string }> {
  if (!isTelegramConfigured()) return { ok: false, error: "Telegram storage is not configured" };
  const tg = telegram();

  let fileId: string | null = null;
  if (source === "pinned") {
    if (!tg.getChatPinnedDocument) return { ok: false, error: "adapter lacks pinned-document support" };
    const pinned = await tg.getChatPinnedDocument(config.telegramChatId);
    if (!pinned || pinned.fileName !== STATE_BACKUP_MARKER) {
      return { ok: false, error: "no Pufflet snapshot pinned in the storage chat" };
    }
    fileId = pinned.fileId;
  } else {
    const list = await loadCheckpoints();
    const cp = messageId ? list.find((c) => c.messageId === messageId) : undefined;
    if (!cp) return { ok: false, error: "checkpoint not found in the recorded history" };
    fileId = cp.fileId;
  }

  try {
    const data = await downloadAndParse(fileId);
    await applyInTransaction(data);
    logRestored(data, source === "pinned" ? "pinned snapshot (manual restore)" : `checkpoint ${messageId} (manual restore)`);
    return { ok: true, counts: data.counts, exportedAt: data.exportedAt };
  } catch (err) {
    const error = `Restore failed: ${err instanceof Error ? err.message : String(err)}`;
    lastError = error;
    return { ok: false, error };
  }
}

/** Recorded checkpoint ring + pinned-doc probe for the Settings UI. */
export async function backupHistory(): Promise<{
  pinned: { found: boolean; messageId?: string; fileName?: string; fileSize?: number };
  checkpoints: CheckpointEntry[];
  hotMessageKnown: boolean;
}> {
  let pinned: { found: boolean; messageId?: string; fileName?: string; fileSize?: number } = { found: false };
  if (isTelegramConfigured()) {
    const tg = telegram();
    if (tg.getChatPinnedDocument) {
      try {
        const doc = await tg.getChatPinnedDocument(config.telegramChatId);
        if (doc && doc.fileName === STATE_BACKUP_MARKER) {
          pinned = { found: true, messageId: doc.messageId, fileName: doc.fileName, fileSize: doc.fileSize };
        }
      } catch {
        // best-effort probe
      }
    }
  }
  const list = await loadCheckpoints();
  return { pinned, checkpoints: list, hotMessageKnown: Boolean(lastMessageId) };
}

function startAutoBackupTimer(): void {
  if (g.__puffletStateBackupTimer) return;
  const timer = setInterval(() => {
    if (dirty && !flushing) void flushStateBackup();
  }, config.stateBackupIntervalMs);
  // Do not keep the process alive just for the timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  g.__puffletStateBackupTimer = timer;
}

/**
 * One-time per-process boot: restore from the pinned snapshot when the DB is
 * empty, then start the periodic flush timer. Never throws.
 */
export async function ensureStateBoot(): Promise<void> {
  g.__puffletStateBoot ??= (async () => {
    if (!config.stateBackupEnabled) return;
    if (!isTelegramConfigured()) return;
    try {
      const res = await restoreIfEmpty();
      if (!res.restored && res.reason && res.reason !== "database not empty") {
        console.log(`[state-backup] no restore: ${res.reason}`);
      }
    } catch (err) {
      console.error("[state-backup] restore failed:", err instanceof Error ? err.message : err);
    }
    startAutoBackupTimer();
  })();
  await g.__puffletStateBoot;
}
