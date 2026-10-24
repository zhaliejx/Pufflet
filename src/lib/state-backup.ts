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
import { telegram } from "@/lib/telegram";
import type { Prisma } from "@prisma/client";

export const SNAPSHOT_VERSION = 1;
export const STATE_BACKUP_MARKER = "pufflet-state-backup.json";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024; // safety cap while restoring

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

export interface SnapshotData {
  version: number;
  exportedAt: string;
  counts: { users: number; folders: number; files: number; apiKeys: number };
  users: SnapshotUser[];
  folders: SnapshotFolder[];
  files: SnapshotFile[];
  apiKeys: SnapshotApiKey[];
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
  if (raw.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version: ${String(raw.version)}`);
  }
  for (const key of ["users", "folders", "files", "apiKeys"] as const) {
    if (!Array.isArray(raw[key])) throw new Error(`Snapshot field "${key}" is missing`);
  }
  return {
    version: raw.version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    counts: raw.counts ?? {
      users: raw.users!.length,
      folders: raw.folders!.length,
      files: raw.files!.length,
      apiKeys: raw.apiKeys!.length,
    },
    users: raw.users as SnapshotUser[],
    folders: raw.folders as SnapshotFolder[],
    files: raw.files as SnapshotFile[],
    apiKeys: raw.apiKeys as SnapshotApiKey[],
  };
}

/**
 * Restore the snapshot inside a transaction. Keeps all row ids so Telegram
 * references (message/file ids) stay valid. Folder self-references are linked
 * in a second pass because every row must exist before a parentId points at it.
 */
export async function applySnapshotData(tx: Prisma.TransactionClient, data: SnapshotData): Promise<void> {
  // Wipe (children first; folders self-reference so null the pointer first).
  await tx.auditEvent.deleteMany({});
  await tx.uploadJob.deleteMany({});
  await tx.session.deleteMany({});
  await tx.apiKey.deleteMany({});
  await tx.file.deleteMany({});
  await tx.folder.updateMany({ data: { parentId: null } });
  await tx.folder.deleteMany({});
  await tx.user.deleteMany({});

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
  const [users, folders, files, apiKeys] = await Promise.all([
    db.user.findMany({ orderBy: { createdAt: "asc" } }),
    db.folder.findMany({ orderBy: { createdAt: "asc" } }),
    db.file.findMany({ orderBy: { createdAt: "asc" } }),
    db.apiKey.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const data: SnapshotData = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { users: users.length, folders: folders.length, files: files.length, apiKeys: apiKeys.length },
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
  };
  return data;
}

/**
 * Upload the current snapshot to the storage chat as a pinned document.
 * Reuses the same message via editMessageMedia so repeated flushes never
 * flood the chat; if the message vanished (user deleted it), a fresh one is
 * sent and pinned again. Pinning is what lets a FRESH container discover the
 * snapshot on boot.
 */
export async function flushStateBackup(): Promise<{ ok: boolean; bytes?: number; error?: string }> {
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
    const bytes = new TextEncoder().encode(serializeSnapshot(data));
    const tg = telegram();
    const chatId = config.telegramChatId;

    // Resolve the reuse target: in-memory pointer first, then the pinned doc.
    if (!lastMessageId && tg.getChatPinnedDocument) {
      try {
        const pinned = await tg.getChatPinnedDocument(chatId);
        if (pinned && pinned.fileName === STATE_BACKUP_MARKER) {
          lastMessageId = pinned.messageId;
          pinConfirmed = true;
        }
      } catch {
        // Discovery is best-effort; a fresh send still works.
      }
    }

    let uploaded = false;
    if (lastMessageId && tg.editMessageDocument) {
      try {
        await tg.editMessageDocument(chatId, lastMessageId, STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes));
        uploaded = true;
      } catch {
        // The message was probably deleted — fall back to a fresh send.
        lastMessageId = null;
        pinConfirmed = false;
      }
    }
    if (!uploaded) {
      const stored = await tg.sendDocument(STATE_BACKUP_MARKER, "application/json", streamFromBytes(bytes));
      lastMessageId = stored.messageId;
      pinConfirmed = false;
    }

    if (!pinConfirmed && lastMessageId && tg.pinChatMessage) {
      try {
        await tg.pinChatMessage(chatId, lastMessageId);
        pinConfirmed = true;
      } catch (err) {
        lastError =
          "Snapshot uploaded but NOT pinned — grant the bot the 'pin messages' admin right so fresh containers can find it. Will retry.";
        lastBackupAt = new Date().toISOString();
        lastBackupSize = bytes.byteLength;
        dirty = true; // retry (edit + pin) on the next flush
        return { ok: false, error: `${lastError} (${err instanceof Error ? err.message : String(err)})` };
      }
    }

    dirty = false;
    lastError = null;
    lastBackupAt = new Date().toISOString();
    lastBackupSize = bytes.byteLength;
    return { ok: true, bytes: bytes.byteLength };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    dirty = true;
    return { ok: false, error: lastError };
  } finally {
    flushing = false;
  }
}

/**
 * Boot-time restore: when the DB has no users (fresh container/disk) and a
 * pinned Pufflet snapshot exists in the storage chat, restore it. Safe to
 * call repeatedly — the whole boot sequence runs once per process.
 */
export async function restoreIfEmpty(): Promise<{ restored: boolean; reason?: string }> {
  const userCount = await db.user.count();
  if (userCount > 0) return { restored: false, reason: "database not empty" };

  const tg = telegram(); // throws when unconfigured — callers guard
  if (!tg.getChatPinnedDocument) return { restored: false, reason: "adapter lacks pinned-document support" };

  const pinned = await tg.getChatPinnedDocument(config.telegramChatId);
  if (!pinned || pinned.fileName !== STATE_BACKUP_MARKER) {
    return { restored: false, reason: "no Pufflet snapshot pinned in the storage chat" };
  }

  const { body } = await tg.openDownloadStream(pinned.fileId);
  const text = await readStreamCapped(body, MAX_SNAPSHOT_BYTES);
  const data = parseSnapshot(text);
  await db.$transaction((tx) => applySnapshotData(tx, data), { timeout: 60_000 });
  console.log(
    `[state-backup] restored snapshot (exported ${data.exportedAt}): ` +
      `${data.counts.users} user(s), ${data.counts.folders} folder(s), ${data.counts.files} file(s), ${data.counts.apiKeys} API key(s)`,
  );
  return { restored: true };
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
