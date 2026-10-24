// Telegram adapter tests with a mocked fetch — verifies request/response
// handling, retry/backoff on transient faults, and error mapping, without
// touching the network.
import { describe, test, expect } from "bun:test";

// Set env BEFORE importing config (dynamic import defeats ESM hoisting; bun
// also auto-loads .env, so we must override explicitly).
process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
process.env.TELEGRAM_CHAT_ID = "-1001234567890";
process.env.TELEGRAM_API_BASE = "https://mock.invalid";

const { createTelegramClient, TelegramError } = await import("../../src/lib/telegram");
type StoredMessage = Awaited<ReturnType<typeof createTelegramClient>> extends never ? never : {
  chatId: string;
  messageId: string;
  fileId: string;
  fileUniqueId: string;
  size: number;
  mimeType: string;
};

function okJson(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}

describe("telegram adapter (mocked fetch)", () => {
  test("getMe parses result", async () => {
    const calls: string[] = [];
    const client = createTelegramClient(async (url: string | URL) => {
      calls.push(String(url));
      return okJson({ id: 42, username: "pufflet_bot" });
    });
    const me = await client.getMe();
    expect(me.username).toBe("pufflet_bot");
    expect(calls[0]).toContain("/getMe");
    expect(calls[0].startsWith("https://mock.invalid/bot")).toBe(true);
  });

  test("sendDocument builds multipart and parses document payload", async () => {
    let seenBody: Uint8Array | null = null;
    let seenCt = "";
    const client = createTelegramClient(async (_url, init?: RequestInit) => {
      seenCt = String((init?.headers as Record<string, string>)["content-type"] ?? "");
      seenBody = new Uint8Array(await new Response(init!.body as ReadableStream).arrayBuffer());
      return okJson({
        message_id: 7,
        chat: { id: -1001234567890 },
        document: {
          file_id: "FILE123",
          file_unique_id: "UNIQ123",
          file_size: 5,
          mime_type: "text/plain",
        },
      });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    const stored: StoredMessage = await client.sendDocument("note.txt", "text/plain", stream);
    expect(stored.fileId).toBe("FILE123");
    expect(stored.fileUniqueId).toBe("UNIQ123");
    expect(stored.messageId).toBe("7");
    expect(seenCt).toContain("multipart/form-data");
    const text = new TextDecoder().decode(seenBody!);
    expect(text).toContain('filename="note.txt"');
    expect(text).toContain("hello");
  });

  test("retries on 429 then succeeds", async () => {
    let attempts = 0;
    const client = createTelegramClient(async () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }));
      }
      return okJson({ id: 1, username: "pufflet_bot" });
    });
    const me = await client.getMe();
    expect(me.id).toBe(1);
    expect(attempts).toBe(3);
  }, 20000);

  test("does not retry on permanent error (400)", async () => {
    let attempts = 0;
    const client = createTelegramClient(async () => {
      attempts++;
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    });
    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramError);
    expect(attempts).toBe(1);
  });

  test("openDownloadStream builds file url and streams bytes", async () => {
    const client = createTelegramClient(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/getFile")) {
        return okJson({ file_id: "FILE123", file_size: 5, file_path: "documents/FILE123/n.txt" });
      }
      if (u.includes("/file/bot123:test-token/documents/FILE123/n.txt")) {
        return new Response(new TextEncoder().encode("hello"));
      }
      throw new Error("unexpected url " + u);
    });
    const { body } = await client.openDownloadStream("FILE123");
    const buf = await new Response(body).arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  test("getFile without file_path maps to TG_NO_FILE_PATH (hosted 20 MB case)", async () => {
    const client = createTelegramClient(async () => okJson({ file_id: "BIG" }));
    await expect(client.openDownloadStream("BIG")).rejects.toMatchObject({ code: "TG_NO_FILE_PATH" });
  });

  test("deleteMessage calls deleteMessage with ids", async () => {
    const urls: string[] = [];
    const client = createTelegramClient(async (url: string | URL) => {
      urls.push(String(url));
      return okJson(true);
    });
    await client.deleteMessage("-1001234567890", "42");
    expect(urls[0]).toContain("deleteMessage");
    expect(urls[0]).toContain("chat_id=-1001234567890");
    expect(urls[0]).toContain("message_id=42");
  });
});
