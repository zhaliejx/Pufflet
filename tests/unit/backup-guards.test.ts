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
