// Telegram storage adapter ---------------------------------------------------
//
// A clean seam between app logic and Telegram specifics. The rest of the app
// only talks to this module; swapping the storage backend means replacing it.
//
// Verified constraints of the HOSTED Bot API (see README for sources):
//   - sendDocument upload:  up to 50 MB per file
//   - getFile download:     up to 20 MB
// The base URL is configurable so a self-hosted "Local Bot API" server
// (2000 MB both directions) can be used without code changes.

import { config, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, isTelegramConfigured } from "@/lib/config";
import { buildMultipartStream, cappedStream, randomBoundary } from "@/lib/multipart";

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryAfterSec?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface StoredMessage {
  chatId: string;
  messageId: string;
  fileId: string;
  fileUniqueId: string;
  size: number;
  mimeType: string;
}

export interface TelegramClientLike {
  sendDocument(filename: string, contentType: string, stream: ReadableStream<Uint8Array>): Promise<StoredMessage>;
  openDownloadStream(fileId: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }>;
  deleteMessage(chatId: string, messageId: string): Promise<void>;
  getMe(): Promise<{ id: number; username: string }>;
}

const RETRYABLE_CODES = new Set(["429", "500", "502", "503", "504"]);
const MAX_ATTEMPTS = 4;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createTelegramClient(fetchImpl: typeof fetch = fetch): TelegramClientLike {
  if (!isTelegramConfigured()) {
    // Fail fast with a clear, secret-free error.
    throw new TelegramError(
      "Telegram storage is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)",
      "TG_NOT_CONFIGURED",
    );
  }
  const base = config.telegramApiBase;
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;

  /** GET-style method call with query params + retry/backoff on transient faults. */
  async function callApi<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    let lastErr: TelegramError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const qs = new URLSearchParams(params).toString();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.telegramRequestTimeoutMs);
        const res = await fetchImpl(`${base}/bot${token}/${method}${qs ? `?${qs}` : ""}`, {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json().catch(() => null)) as
          | { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
          | null;
        if (json?.ok) return json.result as T;
        const code = String(json?.error_code ?? res.status);
        const retryAfter = json?.parameters?.retry_after;
        const retryable = RETRYABLE_CODES.has(code);
        lastErr = new TelegramError(json?.description ?? `Telegram API error ${code}`, code, retryAfter, retryable);
        if (!retryable) throw lastErr;
      } catch (err) {
        if (err instanceof TelegramError && !err.retryable) throw err;
        lastErr = new TelegramError(`Telegram request failed: ${String(err)}`, "NETWORK", undefined, true);
      }
      const backoff = lastErr?.retryAfterSec ? lastErr.retryAfterSec * 1000 : Math.min(8000, 400 * 2 ** (attempt - 1));
      await sleep(backoff);
    }
    throw lastErr ?? new TelegramError("Telegram request failed", "NETWORK");
  }

  return {
    async sendDocument(filename, contentType, stream) {
      const boundary = randomBoundary();
      const body = buildMultipartStream(boundary, { chat_id: chatId }, {
        name: "document",
        filename,
        contentType: contentType || "application/octet-stream",
        stream: cappedStream(stream, MAX_UPLOAD_BYTES),
      });
      type SendResult = {
        message_id: number;
        chat: { id: number | string };
        document?: { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string };
      };
      // Multipart POST (streaming body, duplex half).
      const res = await fetchImpl(`${base}/bot${token}/sendDocument`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        duplex: "half",
      } as RequestInit);
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; result?: SendResult; error_code?: number; description?: string; parameters?: { retry_after?: number } }
        | null;
      if (!json?.ok) {
        const code = String(json?.error_code ?? res.status);
        const retryAfter = json?.parameters?.retry_after;
        throw new TelegramError(
          json?.description ?? `Telegram upload failed (${code})`,
          code,
          retryAfter,
          RETRYABLE_CODES.has(code),
        );
      }
      const msg = json.result;
      const doc = msg.document;
      if (!doc) {
        throw new TelegramError("Telegram did not return a document payload", "TG_BAD_RESPONSE");
      }
      return {
        chatId: String(msg.chat?.id ?? chatId),
        messageId: String(msg.message_id),
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        size: doc.file_size ?? 0,
        mimeType: doc.mime_type ?? contentType,
      };
    },

    async openDownloadStream(fileId) {
      type GetFileResult = { file_path?: string; file_size?: number };
      const meta = await callApi<GetFileResult>("getFile", { file_id: fileId });
      if (!meta.file_path) {
        throw new TelegramError(
          "Telegram returned no file path — on the hosted Bot API, downloads via getFile are limited to 20 MB. Self-host the Local Bot API server for larger files.",
          "TG_NO_FILE_PATH",
        );
      }
      if (typeof meta.file_size === "number" && meta.file_size > MAX_DOWNLOAD_BYTES) {
        throw new TelegramError(
          `File exceeds the configured download limit (${config.maxDownloadMb} MB). Self-host the Local Bot API server and raise MAX_DOWNLOAD_MB.`,
          "TG_TOO_LARGE",
        );
      }
      const url = `${base}/file/bot${token}/${meta.file_path}`;
      const res = await fetchImpl(url, { method: "GET" });
      if (!res.ok || !res.body) {
        throw new TelegramError(`Telegram file download failed (${res.status})`, "TG_DOWNLOAD");
      }
      return { body: res.body, size: meta.file_size ?? 0 };
    },

    async deleteMessage(messageChatId, messageId) {
      await callApi("deleteMessage", { chat_id: messageChatId, message_id: messageId });
    },

    async getMe() {
      type Me = { id: number; username: string };
      const me = await callApi<Me>("getMe");
      return { id: me.id, username: me.username };
    },
  };
}

// Lazily constructed shared client (throws on first use when unconfigured).
let shared: TelegramClientLike | null = null;
export function telegram(): TelegramClientLike {
  if (!shared) shared = createTelegramClient();
  return shared;
}

/** Non-throwing capability probe for health checks / UI status. */
export async function telegramStatus(): Promise<{
  configured: boolean;
  ok: boolean;
  username?: string;
  chatIdMasked?: string;
  error?: string;
}> {
  if (!isTelegramConfigured()) return { configured: false, ok: false };
  const raw = String(config.telegramChatId);
  const masked = raw.length > 6 ? `${raw.slice(0, 3)}****${raw.slice(-3)}` : "****";
  try {
    const me = await telegram().getMe();
    return { configured: true, ok: true, username: me.username, chatIdMasked: masked };
  } catch (err) {
    return { configured: true, ok: false, chatIdMasked: masked, error: String(err instanceof Error ? err.message : err) };
  }
}
