// Mini service: mock Telegram Bot API for local end-to-end testing.
// Implements the subset Pufflet uses: getMe, sendDocument (bytes OR by
// file_id), getFile, /file/bot<token>/<path>, deleteMessage — plus the
// state-backup extras (getChat/pin/editMessageMedia). In-memory index with
// DISK-BACKED file bodies: getFile returns an ABSOLUTE path like the real
// --local Bot API server (which serves no /file/ HTTP route at all).
// NOT for production use — it exists so automated tests and local demos can
// run without real Telegram credentials.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3031;
const TOKEN = "123456:ABC-mock-local";

interface StoredDoc {
  file_id: string;
  file_unique_id: string;
  bytes: Uint8Array;
  size: number;
  filename: string;
  mime: string;
  message_id: number;
  diskPath?: string;
}

const docs = new Map<string, StoredDoc>();
let nextId = 100;
let nextMsgId = 1000;
let pinnedMessageId = 0;

// Where the mock "Bot API server" places files, mirroring --dir of the real
// local server. getFile returns this absolute path; the app reads from disk.
const FILE_DIR = path.join(tmpdir(), "pufflet-telegram-mock-files");
mkdirSync(FILE_DIR, { recursive: true });

function persistToDisk(doc: StoredDoc): void {
  const dir = path.join(FILE_DIR, doc.file_id);
  mkdirSync(dir, { recursive: true });
  const safe = doc.filename.replace(/[^\w.-]/g, "_") || "file.bin";
  const p = path.join(dir, safe);
  writeFileSync(p, doc.bytes);
  doc.diskPath = p;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function ok(result: unknown) {
  return json({ ok: true, result });
}

function err(code: number, description: string) {
  return json({ ok: false, error_code: code, description }, code);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function parseMultipart(body: Uint8Array, boundary: string, partName = "document") {
  // IMPORTANT: all index math must stay in the BYTE domain. Decoding binary
  // bodies as UTF-8 collapses invalid sequences (U+FFFD) and shifts string
  // indices vs byte offsets — ciphertext payloads would get truncated. latin1
  // ("binary") is a 1:1 byte<->char map, so string indexes == byte offsets.
  const text = Buffer.from(body).toString("latin1");
  // find the file part: content-disposition with filename=
  const nameMatch = new RegExp(`name="${partName}"; filename="([^"]+)"`).exec(text);
  const typeMatch = /Content-Type: ([^\r\n]+)/.exec(text.slice(text.indexOf(nameMatch?.[1] ?? "document")));
  if (!nameMatch) return null;
  // binary slice: locate the double CRLF after the file part headers
  const headerEnd = body.findIndex(
    (_, i) =>
      i > 0 &&
      body[i] === 0x0d && body[i + 1] === 0x0a && body[i + 2] === 0x0d && body[i + 3] === 0x0a &&
      text.slice(Math.max(0, i - 200), i + 4).includes(nameMatch[1]),
  );
  const start = headerEnd + 4;
  const closing = text.indexOf(`\r\n--${boundary}`, start);
  const bytes = body.slice(start, closing);
  return { filename: nameMatch[1], mime: (typeMatch?.[1] ?? "application/octet-stream").trim(), bytes };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // file download route: /file/bot<token>/<file_path>
    const filePrefix = `/file/bot${TOKEN}/`;
    if (req.method === "GET" && path.startsWith(filePrefix)) {
      const sub = path.slice(filePrefix.length); // documents/MOCKFILE_x/name
      const file_id = sub.split("/")[1];
      const doc = docs.get(file_id);
      if (!doc) return err(400, "file not found (mock)");
      return new Response(doc.bytes, {
        headers: { "content-type": doc.mime, "content-length": String(doc.size) },
      });
    }

    if (!path.startsWith(`/bot${TOKEN}/`)) {
      return err(401, "Unauthorized (mock)");
    }
    const method = path.slice(`/bot${TOKEN}/`.length);

    if (req.method === "GET" && method === "getMe") {
      return ok({ id: 42, username: "pufflet_mock_bot", first_name: "Pufflet Mock" });
    }

    if (req.method === "POST" && method === "sendDocument") {
      const ct = req.headers.get("content-type") ?? "";
      const m = /boundary=(.+)$/.exec(ct);
      if (!m) return err(400, "no boundary");
      const body = await readAll(req.body as ReadableStream<Uint8Array>);
      const text = Buffer.from(body).toString("latin1");
      const parsed = parseMultipart(body, m[1], "document");

      // document=<file_id> (no file part) -> re-send by file_id: the Bot API
      // resolves the id server-side and posts a fresh message + file_id.
      if (!parsed) {
        const fid = /name="document"\r\n\r\n([^\r\n]+)\r\n/.exec(text)?.[1]?.trim();
        const src = fid ? docs.get(fid) : undefined;
        if (!src) return err(400, `file_id not found (mock): ${fid ?? "?"}`);
        const new_id = `MOCKFILE_${nextId++}`;
        const message_id = nextMsgId++;
        const doc: StoredDoc = {
          file_id: new_id,
          file_unique_id: `uniq_${new_id}`,
          bytes: src.bytes,
          size: src.size,
          filename: src.filename,
          mime: src.mime,
          message_id,
        };
        persistToDisk(doc);
        docs.set(new_id, doc);
        return ok({
          message_id,
          chat: { id: -1001234567890 },
          document: {
            file_id: new_id,
            file_unique_id: doc.file_unique_id,
            file_name: doc.filename,
            mime_type: doc.mime,
            file_size: doc.size,
          },
        });
      }

      const file_id = `MOCKFILE_${nextId++}`;
      const message_id = nextMsgId++;
      const doc: StoredDoc = {
        file_id,
        file_unique_id: `uniq_${file_id}`,
        bytes: parsed.bytes,
        size: parsed.bytes.byteLength,
        filename: parsed.filename,
        mime: parsed.mime,
        message_id,
      };
      persistToDisk(doc);
      docs.set(file_id, doc);
      return ok({
        message_id,
        chat: { id: -1001234567890 },
        document: {
          file_id,
          file_unique_id: doc.file_unique_id,
          file_name: parsed.filename,
          mime_type: parsed.mime,
          file_size: parsed.bytes.byteLength,
        },
      });
    }

    if (req.method === "GET" && method === "getFile") {
      const file_id = url.searchParams.get("file_id") ?? "";
      const doc = docs.get(file_id);
      if (!doc) return err(400, "file not found (mock)");
      if (!doc.diskPath) persistToDisk(doc);
      // The real --local server returns an ABSOLUTE path (and re-downloads
      // missing files from the cloud before answering).
      return ok({ file_id, file_unique_id: doc.file_unique_id, file_size: doc.size, file_path: doc.diskPath });
    }

    if (req.method === "GET" && method.startsWith("file/")) {
      const sub = method.slice("file/".length); // documents/MOCKFILE_x/name
      const file_id = sub.split("/")[1];
      const doc = docs.get(file_id);
      if (!doc) return err(400, "file not found (mock)");
      return new Response(doc.bytes, {
        headers: { "content-type": doc.mime, "content-length": String(doc.size) },
      });
    }

    if (req.method === "GET" && method === "deleteMessage") {
      const message_id = Number(url.searchParams.get("message_id"));
      for (const [fid, doc] of docs) {
        if (doc.message_id === message_id) docs.delete(fid);
      }
      if (pinnedMessageId === message_id) pinnedMessageId = 0;
      return ok(true);
    }

    // --- state-backup extras -------------------------------------------------

    if (req.method === "GET" && method === "getChat") {
      const pinnedDoc = [...docs.values()].find((d) => d.message_id === pinnedMessageId);
      return ok({
        id: -1001234567890,
        ...(pinnedDoc
          ? {
              pinned_message: {
                message_id: pinnedDoc.message_id,
                date: 1700000000,
                document: {
                  file_id: pinnedDoc.file_id,
                  file_unique_id: pinnedDoc.file_unique_id,
                  file_name: pinnedDoc.filename,
                  mime_type: pinnedDoc.mime,
                  file_size: pinnedDoc.size,
                },
              },
            }
          : {}),
      });
    }

    if (req.method === "GET" && method === "pinChatMessage") {
      const message_id = Number(url.searchParams.get("message_id"));
      if (![...docs.values()].some((d) => d.message_id === message_id)) return err(400, "message not found (mock)");
      pinnedMessageId = message_id;
      return ok(true);
    }

    if (req.method === "POST" && method === "editMessageMedia") {
      const ct = req.headers.get("content-type") ?? "";
      const m = /boundary=(.+)$/.exec(ct);
      if (!m) return err(400, "no boundary");
      const body = await readAll(req.body as ReadableStream<Uint8Array>);
      const text = new TextDecoder().decode(body);
      const msgMatch = /name="message_id"\r?\n\r?\n(\d+)/.exec(text);
      if (!msgMatch) return err(400, "no message_id");
      const targetId = Number(msgMatch[1]);
      const existing = [...docs.values()].find((d) => d.message_id === targetId);
      if (!existing) return err(400, "message to edit not found (mock)");
      const parsed = parseMultipart(body, m[1], "pufflet_state");
      if (!parsed) return err(400, "no pufflet_state part");
      // replace the document in place (same message_id, new file_id)
      for (const [fid, doc] of docs) {
        if (doc.message_id === targetId) docs.delete(fid);
      }
      const file_id = `MOCKFILE_${nextId++}`;
      const doc: StoredDoc = {
        file_id,
        file_unique_id: `uniq_${file_id}`,
        bytes: parsed.bytes,
        size: parsed.bytes.byteLength,
        filename: parsed.filename,
        mime: parsed.mime,
        message_id: targetId,
      };
      persistToDisk(doc);
      docs.set(file_id, doc);
      return ok({
        message_id: targetId,
        chat: { id: -1001234567890 },
        document: {
          file_id,
          file_unique_id: doc.file_unique_id,
          file_name: parsed.filename,
          mime_type: parsed.mime,
          file_size: parsed.bytes.byteLength,
        },
      });
    }

    return err(404, `mock: no route ${req.method} ${method}`);
  },
});

console.log(`[telegram-mock] listening on :${PORT} (token ${TOKEN})`);
