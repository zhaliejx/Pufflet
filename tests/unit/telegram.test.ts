// Telegram adapter tests with a mocked fetch — verifies request/response
// handling, retry/backoff on transient faults, and error mapping, without
// touching the network.
import { describe, test, expect } from "bun:test";
import { createTelegramClient, TelegramError } from "../../src/lib/telegram";

// Explicit client options — never coupled to ambient .env values (bun
// auto-loads .env, and unit tests must not depend on import order).
const OPTS = { apiBase: "https://mock.invalid", botToken: "123:test-token", chatId: "-1001234567890" } as const;

type StoredMessage = {
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
    }, OPTS);
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
    }, OPTS);
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
    }, OPTS);
    const me = await client.getMe();
    expect(me.id).toBe(1);
    expect(attempts).toBe(3);
  }, 20000);

  test("does not retry on permanent error (400)", async () => {
    let attempts = 0;
    const client = createTelegramClient(async () => {
      attempts++;
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    }, OPTS);
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
    }, OPTS);
    const { body } = await client.openDownloadStream("FILE123");
    const buf = await new Response(body).arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  test("getFile without file_path maps to TG_NO_FILE_PATH (hosted 20 MB case)", async () => {
    const client = createTelegramClient(async () => okJson({ file_id: "BIG" }), OPTS);
    await expect(client.openDownloadStream("BIG")).rejects.toMatchObject({ code: "TG_NO_FILE_PATH" });
  });

  test("deleteMessage calls deleteMessage with ids", async () => {
    const urls: string[] = [];
    const client = createTelegramClient(async (url: string | URL) => {
      urls.push(String(url));
      return okJson(true);
    }, OPTS);
    await client.deleteMessage("-1001234567890", "42");
    expect(urls[0]).toContain("deleteMessage");
    expect(urls[0]).toContain("chat_id=-1001234567890");
    expect(urls[0]).toContain("message_id=42");
  });

  test("state-backup extras: pin + editMessageDocument round-trip against a mocked API", async () => {
    let edited = 0;
    const client = createTelegramClient(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/getChat")) {
        return okJson({ id: -1001234567890, pinned_message: { message_id: 555, document: { file_id: "PIN", file_name: "pufflet-state-backup.json", file_size: 10 } } });
      }
      if (u.includes("/editMessageMedia")) {
        edited++;
        return okJson({ message_id: 555, document: { file_id: "PIN2", file_size: 12 } });
      }
      if (u.includes("/pinChatMessage")) return okJson(true);
      throw new Error("unexpected url " + u + " " + JSON.stringify(init?.headers ?? {}));
    }, OPTS);

    // discovery from the pinned message
    const pinned = await client.getChatPinnedDocument!(OPTS.chatId);
    expect(pinned?.messageId).toBe("555");
    expect(pinned?.fileName).toBe("pufflet-state-backup.json");

    // edit in place
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    });
    const res = await client.editMessageDocument!(OPTS.chatId, "555", "pufflet-state-backup.json", "application/json", stream);
    expect(edited).toBe(1);
    expect(res.fileId).toBe("PIN2");
    await client.pinChatMessage!(OPTS.chatId, "555");
  });
});
