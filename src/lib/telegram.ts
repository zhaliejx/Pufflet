// Telegram storage adapter ---------------------------------------------------
//
// A clean seam between app logic and Telegram specifics. The rest of the app
// only talks to this module; swapping the storage backend means replacing it.
//
// Verified constraints of the HOSTED Bot API (see README for sources):
//   - sendDocument upload:  up to 50 MB per file
//   - getFile download:     up to 20 MB (HTTP GET /file/bot<token>/<path>)
// The base URL is configurable so a self-hosted "Local Bot API" server
// (2000 MB both directions) can be used without code changes.
//
// LOCAL Bot API download model (verified against the real server source + the
// pinned 10.3 binary): the local server has NO /file/bot... HTTP route at all
// (it answers 404 "Not Found"). In --local mode getFile() returns the file's
// ABSOLUTE PATH ON DISK, and the server transparently (re-)downloads the file
// from Telegram's cloud into its work dir before answering. So in local mode
// bytes are read straight from the filesystem; the HTTP /file/ route is used
// only against the hosted API. If getFile fails on a stale file reference
// (old file, server restarted), the file is "re-sent" by file_id once — that
// re-registers it with the running server and yields a FRESH file_id — and
// the download is retried; callers can persist the repaired ids.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { config, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, isTelegramConfigured, USING_LOCAL_BOT_API } from "@/lib/config";
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

/** A document message pinned in the storage chat (state-backup pointer). */
export interface PinnedDocumentInfo {
  messageId: string;
  fileId: string;
  fileName: string;
  fileSize?: number;
}

export interface DownloadResult {
  body: ReadableStream<Uint8Array>;
  size: number;
  /** Set when a stale file reference was healed via re-send-by-file_id:
   *  the caller should persist these ids over the old ones. */
  repaired?: StoredMessage;
}

export interface DownloadOptions {
  /** Set false for best-effort downloads (e.g. the state snapshot) where a
   *  re-send-by-file_id recovery must not be attempted. Default true. */
  allowRepair?: boolean;
}

export interface TelegramClientLike {
  sendDocument(filename: string, contentType: string, stream: ReadableStream<Uint8Array>): Promise<StoredMessage>;
  openDownloadStream(fileId: string, opts?: DownloadOptions): Promise<DownloadResult>;
  deleteMessage(chatId: string, messageId: string): Promise<void>;
  getMe(): Promise<{ id: number; username: string }>;
  // Optional extras used by the state-backup module. Implemented by the real
  // client; lightweight test mocks may omit them.
  getChatPinnedDocument?(chatId: string): Promise<PinnedDocumentInfo | null>;
  editMessageDocument?(
    chatId: string,
    messageId: string,
    filename: string,
    contentType: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ fileId: string; size: number }>;
  pinChatMessage?(chatId: string, messageId: string): Promise<void>;
}

const RETRYABLE_CODES = new Set(["429", "500", "502", "503", "504"]);
const MAX_ATTEMPTS = 4;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Explicit overrides so tests can build a client without env coupling. */
export interface TelegramClientOptions {
  apiBase?: string;
  botToken?: string;
  chatId?: string;
}

export function createTelegramClient(fetchImpl: typeof fetch = fetch, opts: TelegramClientOptions = {}): TelegramClientLike {
  const base = (opts.apiBase ?? config.telegramApiBase).replace(/\/+$/, "");
  const token = opts.botToken ?? config.telegramBotToken;
  const chatId = opts.chatId ?? config.telegramChatId;
  if (!token || !chatId) {
    // Fail fast with a clear, secret-free error.
    throw new TelegramError(
      "Telegram storage is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)",
      "TG_NOT_CONFIGURED",
    );
  }
  // "Local Bot API" mode = any base other than the hosted endpoint. In this
  // mode getFile returns absolute on-disk paths (verified: the server has no
  // /file/bot... HTTP route) and files are read from the shared filesystem.
  const localMode = base !== "https://api.telegram.org";

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

  // --- download plumbing ----------------------------------------------------

  type GetFileResult = { file_path: string; file_size?: number };

  async function getFileMeta(fileId: string): Promise<GetFileResult> {
    const meta = await callApi<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    const filePath = meta.file_path;
    if (!filePath) {
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
    return { file_path: filePath, file_size: meta.file_size };
  }

  /** Open a file the local Bot API server has placed on the shared filesystem. */
  async function openLocalFile(absPath: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    const st = await stat(absPath); // throws ENOENT when the copy is gone
    const nodeStream = createReadStream(absPath);
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return { body, size: st.size };
  }

  /** Hosted-style HTTP fetch from /file/bot<token>/<path>. */
  async function fetchViaFileUrl(filePath: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    const url = `${base}/file/bot${token}/${encoded}`;
    const res = await fetchImpl(url, { method: "GET" });
    if (!res.ok || !res.body) {
      throw new TelegramError(`Telegram file download failed (${res.status})`, "TG_DOWNLOAD");
    }
    return { body: res.body, size: 0 };
  }

  /** getFile → disk (local mode) or HTTP /file/ (hosted mode). */
  async function resolveDownload(fileId: string): Promise<DownloadResult> {
    const meta = await getFileMeta(fileId);
    if (localMode && meta.file_path.startsWith("/")) {
      try {
        const local = await openLocalFile(meta.file_path);
        return { body: local.body, size: meta.file_size ?? local.size };
      } catch {
        // Local copy missing (GC / wiped work dir): fall through to the HTTP
        // route and then the repair flow, which re-downloads from the cloud.
      }
    }
    const viaHttp = await fetchViaFileUrl(meta.file_path);
    return { body: viaHttp.body, size: meta.file_size || viaHttp.size };
  }

  /**
   * Re-send an existing document by file_id. The Bot API resolves the file_id
   * server-side (no bytes are uploaded) and posts a new message that carries
   * a FRESH file_id — the documented cure for stale file references after a
   * Local Bot API server restart.
   */
  async function copyByFileId(fileId: string): Promise<StoredMessage> {
    const boundary = randomBoundary();
    const body = buildMultipartStream(boundary, { chat_id: chatId, document: fileId });
    type SendResult = {
      message_id: number;
      chat: { id: number | string };
      document?: { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string };
    };
    const res = await fetchImpl(`${base}/bot${token}/sendDocument`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as RequestInit);
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: SendResult; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!json?.ok || !json.result?.document) {
      const code = String(json?.error_code ?? res.status);
      throw new TelegramError(
        json?.description ?? `Telegram file re-send failed (${code})`,
        code,
        json?.parameters?.retry_after,
        RETRYABLE_CODES.has(code),
      );
    }
    const msg = json.result;
    const doc = msg?.document;
    if (!msg || !doc) {
      const code = String(json?.error_code ?? res.status);
      throw new TelegramError(
        json?.description ?? "Telegram did not return a document payload",
        code,
        json?.parameters?.retry_after,
        RETRYABLE_CODES.has(code),
      );
    }
    return {
      chatId: String(msg.chat?.id ?? chatId),
      messageId: String(msg.message_id),
      fileId: doc.file_id,
      fileUniqueId: doc.file_unique_id,
      size: doc.file_size ?? 0,
      mimeType: doc.mime_type ?? "application/octet-stream",
    };
  }

  async function deleteMessageById(deleteChatId: string, deleteMessageId: string): Promise<void> {
    await callApi("deleteMessage", { chat_id: deleteChatId, message_id: deleteMessageId });
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
      const doc = msg?.document;
      if (!msg || !doc) {
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

    async openDownloadStream(fileId, downloadOpts) {
      const allowRepair = downloadOpts?.allowRepair !== false;
      try {
        return await resolveDownload(fileId);
      } catch (err) {
        // Recoverable situations (stale file reference after a server restart,
        // GC raced the local copy, hosted link hiccup) get ONE repair attempt:
        // re-send the document by file_id, which re-registers the file with the
        // running Bot API server and returns a fresh file_id.
        const fatal = err instanceof TelegramError && (err.code === "TG_TOO_LARGE" || err.code === "TG_NO_FILE_PATH");
        if (fatal || !allowRepair) throw err;
      }

      const copied = await copyByFileId(fileId);
      try {
        const got = await resolveDownload(copied.fileId);
        return { ...got, repaired: copied };
      } catch (err) {
        // Clean up the re-sent duplicate before failing — never leave orphans
        // in the storage chat.
        await deleteMessageById(copied.chatId, copied.messageId).catch(() => {});
        throw err;
      }
    },

    async deleteMessage(messageChatId, messageId) {
      await deleteMessageById(messageChatId, messageId);
    },

    async getMe() {
      type Me = { id: number; username: string };
      const me = await callApi<Me>("getMe");
      return { id: me.id, username: me.username };
    },

    // --- state-backup extras ---------------------------------------------------

    async getChatPinnedDocument(pinnedChatId) {
      type ChatInfo = {
        pinned_message?: {
          message_id: number;
          document?: { file_id: string; file_name?: string; file_size?: number };
        };
      };
      const chat = await callApi<ChatInfo>("getChat", { chat_id: pinnedChatId ?? chatId });
      const pinned = chat.pinned_message;
      const doc = pinned?.document;
      if (!pinned || !doc) return null;
      return {
        messageId: String(pinned.message_id),
        fileId: doc.file_id,
        fileName: doc.file_name ?? "",
        fileSize: doc.file_size,
      };
    },

    async editMessageDocument(editChatId, editMessageId, filename, contentType, stream) {
      const boundary = randomBoundary();
      const body = buildMultipartStream(
        boundary,
        {
          chat_id: editChatId ?? chatId,
          message_id: editMessageId,
          media: JSON.stringify({ type: "document", media: "attach://pufflet_state" }),
        },
        {
          name: "pufflet_state",
          filename,
          contentType: contentType || "application/octet-stream",
          stream,
        },
      );
      type EditResult = {
        message_id: number;
        document?: { file_id: string; file_size?: number };
      };
      const res = await fetchImpl(`${base}/bot${token}/editMessageMedia`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        duplex: "half",
      } as RequestInit);
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; result?: EditResult; error_code?: number; description?: string; parameters?: { retry_after?: number } }
        | null;
      if (!json?.ok || !json.result?.document) {
        const code = String(json?.error_code ?? res.status);
        throw new TelegramError(
          json?.description ?? `editMessageMedia failed (${code})`,
          code,
          json?.parameters?.retry_after,
          RETRYABLE_CODES.has(code),
        );
      }
      return {
        fileId: json.result.document.file_id,
        size: json.result.document.file_size ?? 0,
      };
    },

    async pinChatMessage(pinChatId, pinMessageId) {
      await callApi("pinChatMessage", {
        chat_id: pinChatId ?? chatId,
        message_id: pinMessageId,
        disable_notification: "true",
      });
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
  mode: "local" | "hosted";
  username?: string;
  chatIdMasked?: string;
  error?: string;
}> {
  const mode = USING_LOCAL_BOT_API ? "local" : "hosted";
  if (!isTelegramConfigured()) return { configured: false, ok: false, mode };
  const raw = String(config.telegramChatId);
  const masked = raw.length > 6 ? `${raw.slice(0, 3)}****${raw.slice(-3)}` : "****";
  try {
    const me = await telegram().getMe();
    return { configured: true, ok: true, mode, username: me.username, chatIdMasked: masked };
  } catch (err) {
    return { configured: true, ok: false, mode, chatIdMasked: masked, error: String(err instanceof Error ? err.message : err) };
  }
}
