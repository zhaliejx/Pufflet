// rclone integration — PURE logic (no DB, no process spawning) ---------------
//
// Pufflet drives the `rclone` binary to bridge external storage backends
// (S3, Google Drive, SFTP, WebDAV, ...) into the app. Everything that can be
// reasoned about without touching the filesystem lives here so it is cheap to
// unit-test:
//
//   - the provider field catalog (what the settings UI renders, what the
//     server accepts per backend type),
//   - remote name / path validation,
//   - config sanitization + rclone INI materialization (written to a 0600
//     temp file per invocation — never to env vars, which rclone parses
//     ambiguously for remote names, and never back into API responses),
//   - secret masking for API responses,
//   - `rclone lsjson` output parsing and stderr → user-facing error mapping.

import { config } from "@/lib/config";

/** A single configurable provider option in the remote dialog. */
export interface RcloneFieldDef {
  key: string; // rclone config key (lowercase, exactly as rclone expects)
  label: string;
  secret?: boolean; // password input; masked in every API response
  required?: boolean;
  placeholder?: string;
}

export interface RcloneTypeDef {
  type: string; // rclone backend id ("s3", "gdrive", ...)
  label: string;
  hint: string; // honest one-liner shown in the add-remote dialog
  fields: RcloneFieldDef[];
}

/**
 * Backends with a curated field set. Anything rclone supports can still be
 * added via the JSON escape hatch? No — deliberately NOT: unknown keys are
 * rejected so a hostile payload cannot smuggle config directives. The curated
 * list covers the common personal-cloud backends; power users can hit the
 * rclone API through `send`/`ingest` of any other backend by adding it here.
 */
export const RCLONE_TYPES: RcloneTypeDef[] = [
  {
    type: "s3",
    label: "Amazon S3 / compatible",
    hint: "AWS S3 or any S3-compatible endpoint (MinIO, Cloudflare R2, Backblaze...).",
    fields: [
      { key: "provider", label: "Provider", placeholder: "AWS" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "endpoint", label: "Endpoint URL (S3-compatible only)", placeholder: "https://s3.example.com" },
      { key: "access_key_id", label: "Access key ID", secret: true, required: true },
      { key: "secret_access_key", label: "Secret access key", secret: true, required: true },
    ],
  },
  {
    type: "gdrive",
    label: "Google Drive",
    hint: "Paste a token JSON produced by running `rclone authorize \"drive\"` on your own machine.",
    fields: [
      { key: "client_id", label: "Client ID (optional)" },
      { key: "client_secret", label: "Client secret (optional)", secret: true },
      { key: "token", label: "Token JSON", secret: true, required: true, placeholder: '{"access_token":"...","token_type":"Bearer","refresh_token":"..."}' },
      { key: "root_folder_id", label: "Root folder ID (optional)" },
    ],
  },
  {
    type: "sftp",
    label: "SFTP / SSH",
    hint: "Any SSH server with SFTP subsystem. Password or key file (path on the Pufflet server).",
    fields: [
      { key: "host", label: "Host", required: true, placeholder: "example.com" },
      { key: "user", label: "User", required: true },
      { key: "port", label: "Port", placeholder: "22" },
      { key: "pass", label: "Password", secret: true },
      { key: "key_file", label: "Key file (server path, optional)" },
      { key: "key_pass", label: "Key passphrase", secret: true },
    ],
  },
  {
    type: "webdav",
    label: "WebDAV",
    hint: "Nextcloud, ownCloud, or any WebDAV endpoint.",
    fields: [
      { key: "url", label: "URL", required: true, placeholder: "https://cloud.example.com/remote.php/dav/files/me" },
      { key: "vendor", label: "Vendor", placeholder: "nextcloud" },
      { key: "user", label: "User" },
      { key: "pass", label: "Password", secret: true },
    ],
  },
  {
    type: "dropbox",
    label: "Dropbox",
    hint: "Paste a token JSON produced by running `rclone authorize \"dropbox\"` on your own machine.",
    fields: [{ key: "token", label: "Token JSON", secret: true, required: true }],
  },
  {
    type: "onedrive",
    label: "OneDrive",
    hint: "Paste a token JSON produced by running `rclone authorize \"onedrive\"` on your own machine.",
    fields: [
      { key: "token", label: "Token JSON", secret: true, required: true },
      { key: "drive_id", label: "Drive ID (optional)" },
    ],
  },
  {
    type: "azureblob",
    label: "Azure Blob Storage",
    hint: "Azure storage account with a shared key or SAS token.",
    fields: [
      { key: "account", label: "Account", required: true },
      { key: "key", label: "Shared key", secret: true },
      { key: "sas_url", label: "SAS URL (alternative to key)", secret: true },
    ],
  },
  {
    type: "b2",
    label: "Backblaze B2",
    hint: "Backblaze B2 application key.",
    fields: [
      { key: "account", label: "Account ID / applicationKey ID", required: true },
      { key: "key", label: "Application key", secret: true, required: true },
    ],
  },
  {
    type: "local",
    label: "Local disk (server filesystem)",
    hint: "Exposes the Pufflet server's own filesystem over rclone paths (name:/some/dir). Only add this if you trust every account on this instance.",
    fields: [],
  },
];

export function rcloneTypeDef(type: string): RcloneTypeDef | null {
  return RCLONE_TYPES.find((t) => t.type === type) ?? null;
}

export type RcloneRemoteStatus = "unknown" | "ok" | "error";
export const RCLONE_JOB_KINDS = ["push", "pull"] as const;
export type RcloneJobKind = (typeof RCLONE_JOB_KINDS)[number];
export const RCLONE_JOB_STATUSES = ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELED"] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Remote names become `[section]` headers in the generated rclone config and
 * prefixes of `name:path` targets. Constrain them hard: lowercase letters,
 * digits and hyphens only — no colons (rclone remote separator), no
 * underscores/dots (keep INI sections and tooling unambiguous).
 */
export function validateRemoteName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return null;
  return name;
}

/** Max chars for a remote path (rclone has no hard limit; this bounds abuse). */
const MAX_PATH_LEN = 1024;

/**
 * Normalize + validate a remote path ("sub/dir/file.txt"). Returns the
 * cleaned path (no leading/trailing slashes, no "." / ".." / empty segments)
 * or null when the path is unusable. "" is a valid root path.
 */
export function validateRemotePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_PATH_LEN) return null;
  // control characters (incl. newline/NUL) would corrupt argv and the INI
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const segments = raw.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
    if (seg.length > 255) return null;
  }
  return segments.join("/");
}

/** True when `name:path` targets this remote and not some other one. */
export function remoteTarget(name: string, path: string): string {
  return path ? `${name}:${path}` : `${name}:`;
}

// ---------------------------------------------------------------------------
// Config sanitization + INI materialization
// ---------------------------------------------------------------------------

/** Values must be plain single-line strings — they go into an INI file. */
const MAX_VALUE_LEN = 4096;

export type RcloneConfig = Record<string, string>;

/**
 * Keep only known fields for the backend type (+ force `type`). Extra keys
 * from the client are DROPPED, values are trimmed and length-capped, control
 * characters are rejected (null → invalid). Secret fields may be ""
 * (= "leave unchanged" on update; the caller merges with the stored value).
 */
export function sanitizeRcloneConfig(type: string, raw: unknown): { config: RcloneConfig } | { error: string } {
  const def = rcloneTypeDef(type);
  if (!def) return { error: `Unknown rclone backend type: ${String(type).slice(0, 40)}` };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "config must be an object" };
  const out: RcloneConfig = { type };
  for (const field of def.fields) {
    const value = (raw as Record<string, unknown>)[field.key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return { error: `Field “${field.label}” must be a string` };
    const trimmed = value.trim();
    if (trimmed.length > MAX_VALUE_LEN) return { error: `Field “${field.label}” is too long` };
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { error: `Field “${field.label}” contains control characters` };
    if (field.required && trimmed === "") continue; // required-emptiness enforced by the caller (update semantics)
    out[field.key] = trimmed;
  }
  return { config: out };
}

/** Are all `required` fields present (non-empty)? Used on create/test. */
export function configComplete(type: string, cfg: RcloneConfig): string[] {
  const def = rcloneTypeDef(type);
  if (!def) return ["unknown backend type"];
  return def.fields.filter((f) => f.required && !(cfg[f.key] ?? "").length).map((f) => f.label);
}

/**
 * Materialize the rclone INI for one remote. The result is written to a
 * 0600 temp file (see rclone-exec.ts) and handed to rclone via
 * RCLONE_CONFIG=<file>; the file is deleted right after the invocation.
 */
export function buildRcloneConfigIni(name: string, cfg: RcloneConfig): string {
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(cfg)) {
    if (!/^[a-z0-9_]+$/i.test(key)) continue; // defense in depth — sanitize already filters
    lines.push(`${key} = ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Secret masking (API responses never carry provider secrets)
// ---------------------------------------------------------------------------

const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022"; // "••••••"

/**
 * Masked view of a remote config: non-secret values pass through (they help
 * the UI prefill the edit dialog), secrets collapse to bullets. Nothing here
 * is ever enough to reconstruct a credential.
 */
export function maskRcloneConfig(type: string, cfg: RcloneConfig): Record<string, string | null> {
  const def = rcloneTypeDef(type);
  const out: Record<string, string | null> = {};
  for (const field of def?.fields ?? []) {
    const value = cfg[field.key];
    out[field.key] = field.secret ? (value ? MASK : "") : (value ?? "");
  }
  return out;
}

/** True when at least one secret field is set (drives a "credentials set" hint). */
export function hasSecrets(type: string, cfg: RcloneConfig): boolean {
  const def = rcloneTypeDef(type);
  return !!def?.fields.some((f) => f.secret && (cfg[f.key] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// lsjson parsing
// ---------------------------------------------------------------------------

export interface RcloneEntry {
  path: string; // path relative to the listed directory ("" segments removed)
  name: string;
  size: number;
  isDir: boolean;
  modTime: string | null;
  mimeType: string | null;
}

interface RawLsjsonEntry {
  Path?: unknown;
  Name?: unknown;
  Size?: unknown;
  MimeType?: unknown;
  ModTime?: unknown;
  IsDir?: unknown;
}

/**
 * Parse `rclone lsjson` stdout — both the array form (listings) and the
 * single-object form (`--stat`). Returns null when the output is not the
 * expected shape (mocks, proxies, corrupted output).
 */
export function parseLsjson(stdout: string): RcloneEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    parsed = [parsed]; // --stat returns one object
  }
  if (!Array.isArray(parsed)) return null;
  const out: RcloneEntry[] = [];
  for (const raw of parsed as RawLsjsonEntry[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const name = typeof raw.Name === "string" ? raw.Name : null;
    if (!name) return null;
    const isDir = raw.IsDir === true;
    const size = typeof raw.Size === "number" && Number.isFinite(raw.Size) ? Math.max(0, Math.floor(raw.Size)) : isDir ? 0 : 0;
    const relPath = typeof raw.Path === "string" && raw.Path.length ? raw.Path : name;
    out.push({
      path: relPath,
      name,
      size,
      isDir,
      modTime: typeof raw.ModTime === "string" ? raw.ModTime : null,
      mimeType: typeof raw.MimeType === "string" ? raw.MimeType : null,
    });
  }
  return out;
}

/** Directories first, then files, both alphabetical — the natural browse order. */
export function sortEntries(entries: RcloneEntry[]): RcloneEntry[] {
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

// ---------------------------------------------------------------------------
// Error mapping (stderr → safe, user-facing message + stable code)
// ---------------------------------------------------------------------------

export interface RcloneOpError {
  code:
    | "RCLONE_MISSING" // binary not installed / not runnable
    | "RCLONE_TIMEOUT"
    | "REMOTE_NOT_FOUND"
    | "REMOTE_AUTH" // bad credentials / expired token
    | "REMOTE_CONFIG" // incomplete remote config
    | "RCLONE_FAILED"; // anything else
  message: string;
}

/** Collapse whitespace and cap length so stderr never floods a response. */
function tidy(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * Map rclone stderr / exit conditions to a stable error code + a message that
 * is safe to show to users (no secrets — rclone never prints credentials, and
 * we cap + tidy whatever it does print).
 */
export function describeRcloneError(stderr: string, opts?: { missing?: boolean; timeout?: boolean }): RcloneOpError {
  if (opts?.missing) {
    return {
      code: "RCLONE_MISSING",
      message:
        "The rclone binary is not available on the server. Install it (the Docker image ships it) or point PUFFLET_RCLONE_PATH at the binary.",
    };
  }
  if (opts?.timeout) {
    return { code: "RCLONE_TIMEOUT", message: "rclone timed out before finishing the operation" };
  }
  const err = stderr.toLowerCase();
  if (err.includes("directory not found") || err.includes("object not found") || err.includes("couldn't find") || err.includes("file does not exist")) {
    return { code: "REMOTE_NOT_FOUND", message: "Remote path not found" };
  }
  if (
    err.includes("access denied") ||
    err.includes("accessdenied") ||
    err.includes("unauthorized") ||
    err.includes("401") ||
    err.includes("forbidden") ||
    err.includes("invalid_grant") ||
    err.includes("couldn't decrypt") ||
    err.includes("auth") ||
    err.includes("did not find password") ||
    err.includes("password")
  ) {
    return { code: "REMOTE_AUTH", message: "Authentication failed — check the remote's credentials (tokens can expire)" };
  }
  if (err.includes("didn't find section in config file") || err.includes("failed to read config") || err.includes("config file not found")) {
    return { code: "REMOTE_CONFIG", message: "Remote configuration is incomplete — re-save the remote" };
  }
  if (err.includes("not found")) {
    return { code: "REMOTE_NOT_FOUND", message: "Remote path not found" };
  }
  const message = tidy(stderr.split("\n").find((l) => l.trim().length > 0) ?? "rclone failed");
  return { code: "RCLONE_FAILED", message };
}

/** Feature gate used by every route: is rclone both enabled AND resolvable? */
export function rcloneGateError(): RcloneOpError | null {
  if (!config.rcloneEnabled) {
    return { code: "RCLONE_MISSING", message: "The rclone integration is disabled on this server (PUFFLET_RCLONE=false)" };
  }
  return null;
}

/** Parse the "rclone vX.Y.Z" token out of a version banner ("rclone v1.69.0 ..."). */
export function parseVersion(banner: string): string | null {
  const m = /rclone\s+(v[0-9]\S*)/i.exec(banner);
  return m ? m[1] : null;
}
