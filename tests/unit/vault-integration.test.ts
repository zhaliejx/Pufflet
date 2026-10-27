// Integration test: the real upload service layer, with the Telegram adapter
// replaced by an in-memory fake that stores exactly the bytes it was given
// (like the storage chat would). Verifies the vault end-to-end:
//   upload -> what Telegram receives is a padded PUFFENC1 container under an
//   opaque name -> download -> decodeDownloadStream returns the original.
// Run: bun test tests/unit/
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";

// --- fake Telegram storage (captures the bytes "sent to the chat") ----------
import type { StoredMessage, TelegramClientLike } from "../../src/lib/telegram";
// Capture the REAL module before any mocking: bun's mock.module() is process-
// global, so the fake installed below must be restored in afterAll or it would
// poison every other test file that imports @/lib/telegram in the same run.
import * as realTelegramModule from "../../src/lib/telegram";
const REAL_TELEGRAM_MODULE = { ...realTelegramModule };

let lastUpload: { filename: string; contentType: string; bytes: Buffer } | null = null;

const fakeClient: TelegramClientLike = {
  async sendDocument(filename, contentType, stream) {
    const bytes = await readAll(stream);
    lastUpload = { filename, contentType, bytes };
    const msg: StoredMessage = {
      chatId: "-100TEST",
      messageId: "1",
      fileId: "FAKE_FILE_ID",
      fileUniqueId: "FAKE_UNIQ",
      size: bytes.length,
      mimeType: contentType,
    };
    return msg;
  },
  async openDownloadStream(_fileId) {
    if (!lastUpload) throw new Error("nothing uploaded yet");
    const bytes = lastUpload.bytes;
    return {
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      size: bytes.length,
    };
  },
  async deleteMessage() {},
  async getMe() {
    return { id: 1, username: "fake" };
  },
};

// NOTE: the module mock is installed in beforeAll (not at module scope) and
// undone in afterAll — a top-level mock.module leaks into every file bun runs
// after this one (telegram.test.ts used to inherit this fake and fail).
function installFakeTelegramModule() {
  mock.module("@/lib/telegram", () => ({
    telegram: () => fakeClient,
    createTelegramClient: () => fakeClient,
    telegramStatus: async () => ({ configured: true, ok: true, mode: "local" as const }),
  }));
}

// --- real service + vault against the local dev database --------------------
import { db } from "../../src/lib/db";
import { createUploadJob, storeUploadStream } from "../../src/lib/files";
import { decodeDownloadStream } from "../../src/lib/vault";

async function readAll(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value!));
  }
  return Buffer.concat(chunks);
}

describe("vault integration (service layer + fake storage chat)", () => {
  let userId: string;

  beforeAll(async () => {
    installFakeTelegramModule();
    const user = await db.user.create({
      data: {
        email: `vault-it-${Date.now()}@pufflet.test`,
        passwordHash: "scrypt$16384$8$1$00$00",
      },
    });
    userId = user.id;
  });

  afterAll(() => {
    mock.module("@/lib/telegram", () => REAL_TELEGRAM_MODULE);
  });

  test("upload stores a padded container under an opaque name; download restores the original", async () => {
    const plaintext = randomBytes(120_000); // crosses many chunks; big enough for pad+overhead
    const job = await createUploadJob(
      userId,
      { filename: "secret-project.zip", size: plaintext.length, mimeType: "application/zip" },
      "test",
    );

    const file = await storeUploadStream(
      userId,
      job.id,
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(plaintext.subarray(0, 50_000));
          c.enqueue(plaintext.subarray(50_000));
          c.close();
        },
      }),
    );

    // what the storage chat received:
    expect(lastUpload).not.toBeNull();
    const up = lastUpload!;
    expect(up.filename).toMatch(/^pf-[0-9a-f]{24}\.bin$/); // opaque name
    expect(up.contentType).toBe("application/octet-stream"); // no mime leak
    expect(up.bytes.subarray(0, 8).toString("ascii")).toBe("PUFFENC1"); // encrypted container
    expect(up.bytes.indexOf(plaintext.subarray(0, 32))).toBe(-1); // plaintext not visible
    expect(up.bytes.length).toBeGreaterThan(plaintext.length); // padding + overhead

    // what the database recorded:
    expect(file.name).toBe("secret-project.zip");
    expect(file.mimeType).toBe("application/zip");
    expect(file.size).toBe(plaintext.length); // REAL size, not the padded size
    expect(file.status).toBe("READY");
    expect(file.sha256).toBeNull(); // no hashStream passed -> null, unchanged behavior

    // download path: Telegram bytes -> transparent decode -> original bytes
    const { body } = await fakeClient.openDownloadStream(file.tgFileId!);
    const decoded = await readAll(await decodeDownloadStream(body));
    expect(decoded.equals(plaintext)).toBe(true);

    // cleanup this test's rows (leave the vault key: it is process/db state)
    await db.file.delete({ where: { id: file.id } });
    await db.uploadJob.delete({ where: { id: job.id } });
  });

  test("a generated vault key was persisted in the Setting table", async () => {
    const row = await db.setting.findUnique({ where: { key: "vault.masterKey" } });
    expect(row).not.toBeNull();
    expect(Buffer.from(row!.value, "base64").length).toBe(32);
  });
});
