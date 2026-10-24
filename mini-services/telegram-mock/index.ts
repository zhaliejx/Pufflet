// Mini service: mock Telegram Bot API for local end-to-end testing.
// Implements the subset Pufflet uses: getMe, sendDocument, getFile,
// /file/bot<token>/<path>, deleteMessage. In-memory only.
// NOT for production use — it exists so automated tests and local demos can
// run without real Telegram credentials.

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
}

const docs = new Map<string, StoredDoc>();
let nextId = 100;
let nextMsgId = 1000;

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

function parseMultipart(body: Uint8Array, boundary: string) {
  const text = new TextDecoder().decode(body);
  const bIdx = text.indexOf(`--${boundary}`);
  // find the file part: content-disposition with filename=
  const nameMatch = /name="document"; filename="([^"]+)"/.exec(text);
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
      const parsed = parseMultipart(body, m[1]);
      if (!parsed) return err(400, "no document part");
      const file_id = `MOCKFILE_${nextId++}`;
      const message_id = nextMsgId++;
      docs.set(file_id, {
        file_id,
        file_unique_id: `uniq_${file_id}`,
        bytes: parsed.bytes,
        size: parsed.bytes.byteLength,
        filename: parsed.filename,
        mime: parsed.mime,
        message_id,
      });
      return ok({
        message_id,
        chat: { id: -1001234567890 },
        document: {
          file_id,
          file_unique_id: `uniq_${file_id}`,
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
      return ok({ file_id, file_unique_id: doc.file_unique_id, file_size: doc.size, file_path: `documents/${file_id}/${doc.filename}` });
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
      return ok(true);
    }

    return err(404, `mock: no route ${req.method} ${method}`);
  },
});

console.log(`[telegram-mock] listening on :${PORT} (token ${TOKEN})`);
