// Unit tests for the backup reliability guards (pure functions, no DB/Telegram).
import { describe, expect, test } from "bun:test";
import {
  CHECKPOINT_INTERVAL_MS,
  MAX_CHECKPOINTS,
  CheckpointEntry,
  parseCheckpoints,
  pushCheckpoint,
  serializeVerifiedSnapshot,
  shouldCheckpoint,
  shouldRefuseEmptySnapshot,
  SnapshotData,
  SNAPSHOT_VERSION,
} from "@/lib/state-backup";

function entry(at: string, messageId = `m-${at}`): CheckpointEntry {
  return { messageId, fileId: `f-${messageId}`, at, size: 100, files: 3, users: 1 };
}

function snapshot(overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    counts: { users: 1, folders: 0, files: 2, apiKeys: 0, shareLinks: 0 },
    users: [
      {
        id: "u1",
        email: "owner@example.com",
        name: null,
        passwordHash: "x",
        role: "OWNER",
        mustChangePassword: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    folders: [],
    files: [
      {
        id: "f1",
        name: "a.txt",
        normalizedName: "a.txt",
        size: 3,
        mimeType: "text/plain",
        status: "READY",
        starred: false,
        ownerId: "u1",
        folderId: null,
        trashedAt: null,
        sha256: null,
        uploaderLabel: "web",
        tgChatId: "-100",
        tgMessageId: "1",
        tgFileId: "fid",
        tgFileUniqueId: "uniq",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "f2",
        name: "b.txt",
        normalizedName: "b.txt",
        size: 4,
        mimeType: "text/plain",
        status: "READY",
        starred: false,
        ownerId: "u1",
        folderId: null,
        trashedAt: null,
        sha256: null,
        uploaderLabel: "web",
        tgChatId: "-100",
        tgMessageId: "2",
        tgFileId: "fid2",
        tgFileUniqueId: "uniq2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    apiKeys: [],
    settings: [],
    shareLinks: [],
    ...overrides,
  };
}

describe("checkpoint ring", () => {
  test("pushCheckpoint inserts newest-first, dedupes by messageId, trims to max", () => {
    const a = entry("2026-01-01T00:00:00.000Z", "ma");
    const b = entry("2026-01-02T00:00:00.000Z", "mb");
    const c = entry("2026-01-03T00:00:00.000Z", "mc");
    const d = entry("2026-01-04T00:00:00.000Z", "md");

    let ring = pushCheckpoint([], a);
    ring = pushCheckpoint(ring, b);
    ring = pushCheckpoint(ring, c);
    expect(ring.map((x) => x.messageId)).toEqual(["mc", "mb", "ma"]);

    ring = pushCheckpoint(ring, d);
    expect(ring).toHaveLength(MAX_CHECKPOINTS);
    expect(ring.map((x) => x.messageId)).toEqual(["md", "mc", "mb"]);

    // re-pushing the same message does not duplicate
    ring = pushCheckpoint(ring, d);
    expect(ring).toHaveLength(MAX_CHECKPOINTS);
    expect(ring[0].messageId).toBe("md");
  });

  test("pushCheckpoint honors a custom max", () => {
    const ring = pushCheckpoint([entry("2026-01-01T00:00:00.000Z")], entry("2026-01-02T00:00:00.000Z"), 1);
    expect(ring).toHaveLength(1);
  });

  test("shouldCheckpoint: due when empty, due after interval, not due before", () => {
    expect(shouldCheckpoint([], 1000)).toBe(true);

    const now = Date.now();
    expect(shouldCheckpoint([entry(new Date(now - CHECKPOINT_INTERVAL_MS).toISOString())], now)).toBe(true);
    expect(
      shouldCheckpoint([entry(new Date(now - CHECKPOINT_INTERVAL_MS + 60_000).toISOString())], now),
    ).toBe(false);
  });

  test("shouldCheckpoint tolerates unparsable timestamps (treats as never)", () => {
    expect(shouldCheckpoint([entry("not-a-date")], Date.now())).toBe(true);
  });

  test("parseCheckpoints: garbage in, empty list out; valid entries kept", () => {
    expect(parseCheckpoints(null)).toEqual([]);
    expect(parseCheckpoints(undefined)).toEqual([]);
    expect(parseCheckpoints("")).toEqual([]);
    expect(parseCheckpoints("{not json")).toEqual([]);
    expect(parseCheckpoints("42")).toEqual([]);
    expect(parseCheckpoints('{"a":1}')).toEqual([]);
    expect(parseCheckpoints('[{"messageId":"m1","fileId":"f1","at":"2026-01-01T00:00:00.000Z"}]')).toHaveLength(1);
    // missing fileId -> dropped
    expect(parseCheckpoints('[{"messageId":"m1","at":"2026-01-01T00:00:00.000Z"}]')).toEqual([]);
  });
});

describe("empty-index overwrite guard", () => {
  test("refuses empty index only when a previous good backup exists", () => {
    expect(shouldRefuseEmptySnapshot(0, true)).toBe(true);
    expect(shouldRefuseEmptySnapshot(0, false)).toBe(false);
    expect(shouldRefuseEmptySnapshot(1, true)).toBe(false);
    expect(shouldRefuseEmptySnapshot(3, false)).toBe(false);
  });
});

describe("serializeVerifiedSnapshot", () => {
  test("a healthy snapshot round-trips and is returned unchanged", () => {
    const text = serializeVerifiedSnapshot(snapshot());
    expect(JSON.parse(text).version).toBe(SNAPSHOT_VERSION);
    expect(JSON.parse(text).counts.files).toBe(2);
  });

  test("a structurally broken snapshot throws instead of uploading", () => {
    const broken = snapshot({ users: undefined as unknown as SnapshotData["users"] });
    expect(() => serializeVerifiedSnapshot(broken)).toThrow();
  });

  test("an unsupported snapshot version throws", () => {
    const bad = snapshot({ version: 99 });
    expect(() => serializeVerifiedSnapshot(bad)).toThrow();
  });
});

// ---- dangling-reference pruning (torn-snapshot restores) --------------------

import { pruneDanglingRefs, verifySnapshotUpload } from "@/lib/state-backup";

function folder(id: string, ownerId = "u1", parentId: string | null = null): SnapshotData["folders"][number] {
  return {
    id,
    name: id,
    ownerId,
    parentId,
    trashedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fileIn(id: string, ownerId: string, folderId: string | null): SnapshotData["files"][number] {
  return {
    id,
    name: `${id}.txt`,
    normalizedName: `${id}.txt`,
    size: 3,
    mimeType: "text/plain",
    status: "READY",
    starred: false,
    ownerId,
    folderId,
    trashedAt: null,
    sha256: null,
    uploaderLabel: "web",
    tgChatId: "-100",
    tgMessageId: "1",
    tgFileId: "fid",
    tgFileUniqueId: "uniq",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("pruneDanglingRefs (torn snapshots restore instead of crashing)", () => {
  test("a consistent snapshot passes through untouched", () => {
    const snap = snapshot();
    snap.folders = [folder("d1")];
    snap.files = [fileIn("f1", "u1", "d1"), fileIn("f2", "u1", null)];
    const res = pruneDanglingRefs(snap);
    expect(res.droppedTotal).toBe(0);
    expect(res.data).toBe(snap); // same object, zero-copy fast path
  });

  test("drops files whose folder vanished mid-race, keeps the rest", () => {
    const snap = snapshot();
    snap.files = [fileIn("f1", "u1", "missing-folder"), fileIn("f2", "u1", null)];
    const res = pruneDanglingRefs(snap);
    expect(res.dropped.files).toBe(1);
    expect(res.data.files.map((f) => f.id)).toEqual(["f2"]);
    expect(res.data.counts.files).toBe(1);
  });

  test("drops deep orphan chains: folder under missing parent, file inside it", () => {
    const snap = snapshot();
    snap.folders = [folder("child", "u1", "missing-root"), folder("ok")];
    snap.files = [fileIn("f1", "u1", "child"), fileIn("f2", "u1", "ok")];
    const res = pruneDanglingRefs(snap);
    expect(res.data.folders.map((f) => f.id)).toEqual(["ok"]);
    expect(res.dropped.folders).toBe(1);
    expect(res.dropped.files).toBe(1);
  });

  test("drops api keys and share links pointing outside the snapshot", () => {
    const snap = snapshot();
    snap.apiKeys = [
      { id: "k1", name: "keep", prefix: "p", hash: "h", scopes: "read", userId: "u1", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "k2", name: "drop", prefix: "p", hash: "h", scopes: "read", userId: "ghost-user", expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    snap.shareLinks = [
      { id: "s1", token: "t1", fileId: "f1", createdBy: "u1", createdAt: "2026-01-01T00:00:00.000Z", revokedAt: null, expiresAt: null, downloads: 0, lastDownloadAt: null },
      { id: "s2", token: "t2", fileId: "missing-file", createdBy: "u1", createdAt: "2026-01-01T00:00:00.000Z", revokedAt: null, expiresAt: null, downloads: 0, lastDownloadAt: null },
    ];
    const res = pruneDanglingRefs(snap);
    expect(res.dropped.apiKeys).toBe(1);
    expect(res.dropped.shareLinks).toBe(1);
    expect(res.data.apiKeys.map((k) => k.id)).toEqual(["k1"]);
    expect(res.data.shareLinks.map((l) => l.id)).toEqual(["s1"]);
  });

  test("folders owned by a missing user are dropped with their subtrees", () => {
    const snap = snapshot();
    snap.folders = [folder("orphan", "ghost-owner"), folder("nested", "u1", "orphan")];
    snap.files = [fileIn("f1", "u1", "nested")];
    const res = pruneDanglingRefs(snap);
    expect(res.data.folders).toHaveLength(0);
    expect(res.dropped.files).toBe(1);
  });
});

describe("verifySnapshotUpload (truncated uploads are failures)", () => {
  test("matching sizes pass", () => {
    expect(verifySnapshotUpload(1234, 1234)).toBe(true);
  });
  test("mismatched sizes fail", () => {
    expect(verifySnapshotUpload(1234, 1000)).toBe(false);
    expect(verifySnapshotUpload(1234, 2000)).toBe(false);
  });
  test("unknown reported size (0/null) is tolerated, not a false failure", () => {
    expect(verifySnapshotUpload(1234, null)).toBe(true);
    expect(verifySnapshotUpload(1234, undefined)).toBe(true);
  });
});
