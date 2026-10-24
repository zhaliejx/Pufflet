// Unit tests for the state-backup snapshot logic (no server, no real Telegram).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import {
  SNAPSHOT_VERSION,
  STATE_BACKUP_MARKER,
  serializeSnapshot,
  parseSnapshot,
  applySnapshotData,
  type SnapshotData,
} from "../../src/lib/state-backup";

const SAMPLE: SnapshotData = {
  version: SNAPSHOT_VERSION,
  exportedAt: "2026-01-01T00:00:00.000Z",
  counts: { users: 1, folders: 2, files: 1, apiKeys: 1 },
  users: [
    {
      id: "u1",
      email: "owner@pufflet.test",
      name: "Owner",
      passwordHash: "scrypt$16384$8$1$salt$hash",
      role: "OWNER",
      mustChangePassword: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  folders: [
    {
      id: "f1",
      name: "Photos",
      ownerId: "u1",
      parentId: null,
      trashedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "f2",
      name: "2026",
      ownerId: "u1",
      parentId: "f1",
      trashedAt: null,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  files: [
    {
      id: "file1",
      name: "cat.png",
      normalizedName: "cat.png",
      size: 123,
      mimeType: "image/png",
      status: "READY",
      starred: true,
      ownerId: "u1",
      folderId: "f2",
      trashedAt: null,
      sha256: "abc",
      uploaderLabel: "web",
      tgChatId: "-100123",
      tgMessageId: "42",
      tgFileId: "TGFILE",
      tgFileUniqueId: "TGUNIQ",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
  ],
  apiKeys: [
    {
      id: "k1",
      name: "script",
      prefix: "tc_live_ab12",
      hash: "deadbeef",
      scopes: "read,write",
      userId: "u1",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-01-04T00:00:00.000Z",
    },
  ],
};

// Minimal fake Prisma transaction client that records every call in order.
function fakeTx() {
  const calls: Array<{ op: string; model: string; args?: unknown }> = [];
  const record = (model: string, op: string) => (args?: unknown) => {
    calls.push({ op, model, args });
    if (op === "findUnique" || op === "findFirst") return Promise.resolve(null);
    return Promise.resolve({});
  };
  const model = (name: string) => ({
    deleteMany: record(name, "deleteMany"),
    updateMany: record(name, "updateMany"),
    create: record(name, "create"),
    update: record(name, "update"),
    findUnique: record(name, "findUnique"),
  });
  return {
    calls,
    tx: {
      auditEvent: model("auditEvent"),
      uploadJob: model("uploadJob"),
      session: model("session"),
      apiKey: model("apiKey"),
      file: model("file"),
      folder: model("folder"),
      user: model("user"),
    } as never,
  };
}

describe("snapshot serialize/parse", () => {
  test("round-trip preserves data", () => {
    const parsed = parseSnapshot(serializeSnapshot(SAMPLE));
    expect(parsed).toEqual(SAMPLE);
  });
  test("rejects unknown versions", () => {
    expect(() => parseSnapshot(JSON.stringify({ ...SAMPLE, version: 99 }))).toThrow(/version/i);
  });
  test("rejects garbage", () => {
    expect(() => parseSnapshot("not json")).toThrow();
    expect(() => parseSnapshot("{}")).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ version: 1 }))).toThrow();
  });
  test("marker filename is stable", () => {
    expect(STATE_BACKUP_MARKER).toBe("pufflet-state-backup.json");
  });
});

describe("applySnapshotData", () => {
  test("wipes existing rows, restores users -> folders (parents first) -> files -> keys", async () => {
    const { tx, calls } = fakeTx();
    await applySnapshotData(tx, SAMPLE);

    const models = calls.map((c) => c.model);
    // everything wiped before anything is created
    const lastWipe = Math.max(...calls.map((c, i) => (c.op === "deleteMany" ? i : -1)));
    const firstCreate = calls.findIndex((c) => c.op === "create");
    expect(lastWipe).toBeLessThan(firstCreate);

    // users restored
    expect(models).toContain("user");
    const userCreate = calls.find((c) => c.model === "user" && c.op === "create");
    expect((userCreate!.args as { data: { id: string } }).data.id).toBe("u1");

    // folders created WITHOUT parentId, then linked in a second pass
    const folderCreates = calls.filter((c) => c.model === "folder" && c.op === "create");
    expect(folderCreates).toHaveLength(2);
    for (const c of folderCreates) {
      expect((c.args as { data: Record<string, unknown> }).data.parentId).toBeUndefined();
    }
    const folderLinks = calls.filter((c) => c.model === "folder" && c.op === "update");
    expect(folderLinks).toHaveLength(1);
    expect((folderLinks[0].args as { where: { id: string }; data: { parentId: string } }).where.id).toBe("f2");
    expect((folderLinks[0].args as { data: { parentId: string } }).data.parentId).toBe("f1");

    // files + api keys restored with their original ids
    const fileCreate = calls.find((c) => c.model === "file" && c.op === "create");
    expect((fileCreate!.args as { data: { id: string; tgFileId: string } }).data.tgFileId).toBe("TGFILE");
    const keyCreate = calls.find((c) => c.model === "apiKey" && c.op === "create");
    expect((keyCreate!.args as { data: { id: string; hash: string } }).data.hash).toBe("deadbeef");

    // dates revived as Date objects
    expect(((userCreate!.args as { data: { createdAt: unknown } }).data.createdAt) instanceof Date).toBe(true);
  });

  test("parent folders are created before their children are linked", async () => {
    const { tx, calls } = fakeTx();
    await applySnapshotData(tx, SAMPLE);
    const f1Create = calls.findIndex(
      (c) => c.model === "folder" && c.op === "create" && (c.args as { data: { id: string } }).data.id === "f1",
    );
    const f2Link = calls.findIndex(
      (c) => c.model === "folder" && c.op === "update" && (c.args as { where: { id: string } }).where.id === "f2",
    );
    expect(f1Create).toBeGreaterThan(-1);
    expect(f2Link).toBeGreaterThan(f1Create);
  });
});
