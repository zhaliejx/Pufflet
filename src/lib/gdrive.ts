// Google Drive link parsing + direct fetch ------------------------------------
//
// Pufflet imports files straight from Google Drive: the user pastes a share
// link, the server pulls the bytes (streaming — never fully buffered) and
// funnels them into the normal upload pipeline (vault -> Telegram). No OAuth,
// no Google API project: the file only has to be shared "Anyone with the
// link". This bypasses the flaky Android "My Drive" entry in the system file
// picker entirely — the phone never downloads the file at all.
//
// PUFFLET_GDRIVE_BASE can point the download endpoint at a local fake (see
// mini-services/telegram-mock) so end-to-end tests run without internet.

import { ServiceError } from "@/lib/files";

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com", "drive.usercontent.google.com"]);

const DOCS_LABELS: Record<string, string> = {
  document: "Docs",
  presentation: "Slides",
  spreadsheets: "Sheets",
  forms: "Forms",
  drawings: "Drawings",
};

// Reverse map used only when Drive omits the filename header.
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/zip": "zip",
  "application/x-7z-compressed": "7z",
  "application/gzip": "gz",
  "application/x-rar-compressed": "rar",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.android.package-archive": "apk",
};

export type ParsedDriveLink = { ok: true; fileId: string } | { ok: false; error: string };

/** Extract the file id from every common Google Drive link shape (or accept
 *  a raw file id). Folders and Docs/Sheets/Slides links get actionable
 *  errors instead of a confusing download failure. */
export function parseDriveLink(raw: string): ParsedDriveLink {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, error: "Paste a Google Drive link (or a raw file id) first." };

  if (FILE_ID_RE.test(input)) return { ok: true, fileId: input };

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return {
      ok: false,
      error: "That doesn't look like a URL. Paste a link like https://drive.google.com/file/d/…/view or a raw file id.",
    };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "Only http(s) Google Drive links are supported." };
  }
  const host = u.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host)) {
    return { ok: false, error: `Only Google Drive links are supported (got “${host}”).` };
  }

  const path = u.pathname;

  if (/\/folders\//.test(path)) {
    return {
      ok: false,
      error:
        "That's a Drive FOLDER link — Pufflet imports single files. Open the file in Google Drive and copy its share link (right-click → Share → Copy link).",
    };
  }
  const docs = path.match(/\/(document|presentation|spreadsheets|forms|drawings)\/d\/([A-Za-z0-9_-]{10,})/);
  if (docs) {
    return {
      ok: false,
      error: `That's a Google ${DOCS_LABELS[docs[1]] ?? "Docs"} link. Use “File → Download” in Google Docs to export it, then upload the exported file — or share the file from drive.google.com and paste that link.`,
    };
  }
  const file = path.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (file) return { ok: true, fileId: file[1] };

  const id = u.searchParams.get("id");
  if (id && FILE_ID_RE.test(id)) return { ok: true, fileId: id };

  return {
    ok: false,
    error: "Couldn't find a file id in that link. Use the file's share link (drive.google.com/file/d/…) or paste the raw file id.",
  };
}

function gdriveBase(): string {
  return (process.env.PUFFLET_GDRIVE_BASE ?? "https://drive.usercontent.google.com").replace(/\/+$/, "");
}

/** The direct-download endpoint. `confirm=t` skips the "can't scan this
 *  file" interstitial for most files; extractConfirmForm handles the rest. */
export function driveDownloadUrl(fileId: string): string {
  return `${gdriveBase()}/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
}

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function driveFetch(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    cache: "no-store",
    signal,
    headers: { "user-agent": BROWSER_UA, accept: "*/*" },
  });
}

/** Read at most `max` bytes of a body as text — used to diagnose the HTML
 *  pages Drive serves instead of the file (scan-warning form, sign-in, …). */
async function readBodyText(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
  signal: AbortSignal,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) {
      reader.cancel().catch(() => {});
      throw new ServiceError("Import canceled", 409);
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= max) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/** Content-Disposition parser: RFC 5987 filename* wins, then quoted/plain
 *  filename. Returns null when the header is absent or empty. */
export function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch {
      // malformed percent-encoding — fall through to the plain filename
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header);
  if (quoted) {
    const value = quoted[1].replace(/\\(.)/g, "$1").trim();
    if (value) return value;
  }
  const plain = /filename\s*=\s*([^;]+)/.exec(header);
  const value = plain?.[1]?.trim().replace(/^"|"$/g, "").trim();
  return value || null;
}

/** When Drive serves the "virus scan warning" interstitial, the real
 *  download lives behind the confirm form. Rebuild that URL (absolute or
 *  relative action + hidden inputs) so the server can follow it itself. */
export function extractConfirmForm(html: string): string | null {
  if (!/usercontent\.google\.com\/download|virus scan warning|download anyway/i.test(html)) return null;
  const action = /<form[^>]*action\s*=\s*"([^"]+)"/i.exec(html)?.[1];
  if (!action) return null;
  let target: URL;
  try {
    target = new URL(action, "https://drive.usercontent.google.com");
  } catch {
    return null;
  }
  for (const m of html.matchAll(/<input[^>]*>/gi)) {
    const tag = m[0];
    const name = /name\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (!name) continue;
    if (/type\s*=\s*"submit"/i.test(tag)) continue;
    const value = /value\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "";
    target.searchParams.set(name, value);
  }
  if (!target.searchParams.has("confirm")) target.searchParams.set("confirm", "t");
  if (!target.searchParams.has("export")) target.searchParams.set("export", "download");
  return target.toString();
}

/** Map an HTML "this isn't a download" page to an actionable error. Never
 *  echo page contents — only classifications. */
export function describeDrivePage(html: string): ServiceError {
  const h = html.slice(0, 100_000);
  if (/accounts\.google\.com|sign in|sign-in/i.test(h)) {
    return new ServiceError(
      "This file is not publicly shared. In Google Drive, right-click the file → Share → set “Anyone with the link”, then paste the link again.",
      403,
      "DRIVE_NOT_PUBLIC",
    );
  }
  if (/error 404|doesn'?t exist|not exist|you don'?t have access|cannot be found|bad request/i.test(h)) {
    return new ServiceError(
      "Google Drive says that file doesn't exist or the link is broken. Double-check the link.",
      404,
      "DRIVE_NOT_FOUND",
    );
  }
  if (/quota|too many users|downloaded too much/i.test(h)) {
    return new ServiceError(
      "Google Drive is rate-limiting this file (too many downloads today). Try again later.",
      429,
      "DRIVE_QUOTA",
    );
  }
  if (/virus scan warning|download anyway/i.test(h)) {
    return new ServiceError(
      "Google Drive is asking for a virus-scan confirmation that can't be completed for this link. Re-share the link, or download the file once and upload it.",
      422,
      "DRIVE_SCAN_PAGE",
    );
  }
  return new ServiceError(
    "Google Drive didn't return the file for this link. Make sure it is shared as “Anyone with the link” and is a file (not a folder).",
    400,
    "DRIVE_LINK",
  );
}

function statusToError(status: number): ServiceError {
  if (status === 401 || status === 403) {
    return new ServiceError(
      "This file is not publicly shared. In Google Drive, right-click the file → Share → set “Anyone with the link”, then paste the link again.",
      403,
      "DRIVE_NOT_PUBLIC",
    );
  }
  if (status === 404) {
    return new ServiceError(
      "Google Drive says that file doesn't exist or the link is broken. Double-check the link.",
      404,
      "DRIVE_NOT_FOUND",
    );
  }
  if (status === 429) {
    return new ServiceError(
      "Google Drive is rate-limiting this file (too many downloads today). Try again later.",
      429,
      "DRIVE_QUOTA",
    );
  }
  if (status >= 500) {
    return new ServiceError("Google Drive had a server error — try again shortly.", 502, "DRIVE_UNAVAILABLE");
  }
  return new ServiceError(
    "Google Drive didn't return the file for this link. Make sure it is shared as “Anyone with the link” and is a file (not a folder).",
    400,
    "DRIVE_LINK",
  );
}

function cleanMime(contentType: string): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function fallbackName(fileId: string, mime: string): string {
  const ext = MIME_EXT[mime] ?? "bin";
  return `drive-${fileId.slice(0, 10)}.${ext}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export interface DriveFileHandle {
  /** Live download stream — consume it promptly; it is never buffered. */
  stream: ReadableStream<Uint8Array>;
  name: string;
  /** Bytes from content-length; 0 when Drive does not declare a size. */
  size: number;
  mimeType: string;
}

/**
 * Open a Drive file for streaming. Resolves once the response headers are
 * understood (fast) — the caller streams the body. Handles the scan-warning
 * confirm form, sign-in / not-found / quota pages, and maps every failure to
 * a clear ServiceError the UI can show verbatim.
 */
export async function fetchDriveFile(fileId: string, signal: AbortSignal): Promise<DriveFileHandle> {
  let res: Response;
  try {
    res = await driveFetch(driveDownloadUrl(fileId), signal);
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw new ServiceError("Import canceled", 409);
    throw new ServiceError(
      "Could not reach Google Drive — check this server's internet connection and try again.",
      502,
      "DRIVE_UNREACHABLE",
    );
  }

  // HTML response = an interstitial, not the file.
  if (cleanMime(res.headers.get("content-type") ?? "") === "text/html") {
    const page = await readBodyText(res.body, 256 * 1024, signal);
    const confirmUrl = extractConfirmForm(page);
    if (!confirmUrl) throw describeDrivePage(page);
    try {
      res = await driveFetch(confirmUrl, signal);
    } catch (err) {
      if (signal.aborted || isAbort(err)) throw new ServiceError("Import canceled", 409);
      throw new ServiceError("Could not reach Google Drive — try again.", 502, "DRIVE_UNREACHABLE");
    }
    if (cleanMime(res.headers.get("content-type") ?? "") === "text/html") {
      throw describeDrivePage(await readBodyText(res.body, 256 * 1024, signal));
    }
  }

  if (!res.ok) throw statusToError(res.status);

  const mimeType = cleanMime(res.headers.get("content-type") ?? "");
  const name =
    parseFilenameFromContentDisposition(res.headers.get("content-disposition")) || fallbackName(fileId, mimeType);
  const len = Number(res.headers.get("content-length") ?? "0");
  return {
    stream: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    name,
    size: Number.isFinite(len) && len > 0 ? len : 0,
    mimeType: mimeType || "application/octet-stream",
  };
}
