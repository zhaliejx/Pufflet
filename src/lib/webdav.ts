// Pure WebDAV helpers for the /dav mount ("Pufflet as a remote").
// No DB / no request objects here — everything is unit-testable. The server
// side (auth, resolution, streaming) lives in webdav-server.ts and the route
// handler in app/dav/[[...path]]/route.ts.
//
// Why WebDAV: rclone ships a battle-tested `webdav` backend (vendor=other),
// so exposing this protocol turns Pufflet into a mountable rclone remote
// with zero client-side setup beyond an API key. No extra binary needed —
// unlike `rclone serve`, Pufflet's storage lives in encrypted Telegram
// messages, so the DAV tree is served straight from the app's own pipelines.

// The mount lives under /api because Next.js Pages API routes are the only
// handler type that dispatches WebDAV's arbitrary methods (PROPFIND, MKCOL,
// MOVE, COPY) — App Router handlers answer them with a bare 400.
export const DAV_MOUNT = "/api/dav";

// ---------------------------------------------------------------------------
// Path segments
// ---------------------------------------------------------------------------

/**
 * Decode one URL path segment. Next.js hands route params through as raw
 * (still-encoded) strings in some versions and pre-decoded in others, so a
 * single best-effort decode pass is applied: if the segment contains no
 * percent-escapes this is a no-op, and malformed escapes fall back to the raw
 * value. Filenames are validated afterwards anyway (sanitizeName rules on the
 * server side), so a mis-decoded name can never resolve to the wrong record
 * silently — it surfaces as 400/404 instead.
 */
export function decodeDavSegment(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Validate the decoded path of a DAV request into clean name segments.
 * Returns null when any segment is structurally invalid (traversal, control
 * chars, too long, "."/"..") — callers map that to 400.
 */
export function parseDavSegments(rawPath: string[] | undefined, maxDepth: number): string[] | null {
  if (!rawPath || rawPath.length === 0) return [];
  if (rawPath.length > maxDepth) return null;
  const out: string[] = [];
  for (const raw of rawPath) {
    // Guard against an encoded slash sneaking in: a real name can never
    // contain "/" (sanitizeName forbids it), so "/dav/a%2Fb" must be rejected
    // rather than treated as the name "a/b".
    if (raw === "" || /%2f/i.test(raw)) return null;
    const seg = decodeDavSegment(raw);
    if (!seg || seg.length > 180) return null;
    if (/[/\\\u0000-\u001f]/.test(seg)) return null;
    if (seg === "." || seg === "..") return null;
    out.push(seg);
  }
  return out;
}

/** Percent-encoded href for a PROPFIND response (trailing slash = collection). */
export function hrefFor(segments: string[], isFolder: boolean): string {
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  const base = encoded ? `${DAV_MOUNT}/${encoded}` : DAV_MOUNT;
  return isFolder ? `${base}/` : base;
}

// ---------------------------------------------------------------------------
// Destination header (MOVE / COPY)
// ---------------------------------------------------------------------------

/**
 * Parse a WebDAV Destination header into Pufflet path segments. Accepts both
 * absolute URIs ("https://host/dav/a/b") and absolute paths ("/dav/a/b").
 * Returns null when the header is missing, foreign to this mount, or
 * structurally invalid — callers map that to 400/502.
 */
export function parseDavDestination(header: string | null | undefined, maxDepth: number): string[] | null {
  if (!header) return null;
  let pathname: string;
  if (/^https?:\/\//i.test(header)) {
    try {
      pathname = new URL(header).pathname;
    } catch {
      return null;
    }
  } else if (header.startsWith("/")) {
    pathname = header;
  } else {
    return null;
  }
  if (pathname !== DAV_MOUNT && !pathname.startsWith(`${DAV_MOUNT}/`)) return null;
  const raw = pathname.slice(DAV_MOUNT.length).split("/").filter((s) => s !== "");
  // Strip query/fragment remnants that some clients append to destinations.
  return parseDavSegments(raw, maxDepth);
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;",
  );
}

export interface DavResourceProps {
  segments: string[];
  isFolder: boolean;
  name: string;
  size?: number;
  mimeType?: string;
  createdAt: Date;
  updatedAt: Date;
  etag?: string;
}

function propBlock(r: DavResourceProps): string {
  const type = r.isFolder ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>";
  const parts = [
    `<D:displayname>${xmlEscape(r.name)}</D:displayname>`,
    type,
    `<D:creationdate>${r.createdAt.toISOString()}</D:creationdate>`,
    `<D:getlastmodified>${r.updatedAt.toUTCString()}</D:getlastmodified>`,
  ];
  if (!r.isFolder) {
    parts.push(`<D:getcontentlength>${r.size ?? 0}</D:getcontentlength>`);
    parts.push(`<D:getcontenttype>${xmlEscape(r.mimeType || "application/octet-stream")}</D:getcontenttype>`);
    if (r.etag) parts.push(`<D:getetag>${xmlEscape(r.etag)}</D:getetag>`);
  }
  return parts.join("");
}

/**
 * RFC 4918 multistatus body. Every property is always reported (an "allprop"
 * answer is legal even for a named-prop PROPFIND request — clients pick what
 * they need out of the response).
 */
export function buildMultistatus(resources: DavResourceProps[]): string {
  const body = resources
    .map(
      (r) =>
        `<D:response><D:href>${xmlEscape(hrefFor(r.segments, r.isFolder))}</D:href>` +
        `<D:propstat><D:prop>${propBlock(r)}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`
  );
}

/** Minimal HTML listing for GET-on-collection (browsers, human debugging). */
export function buildDirIndex(segments: string[], folders: string[], files: string[]): string {
  const here = hrefFor(segments, true);
  const item = (label: string, targetSegments: string[], isFolder: boolean) => {
    const href = xmlEscape(hrefFor(targetSegments, isFolder));
    return `<li><a href="${href}">${xmlEscape(label)}${isFolder ? "/" : ""}</a></li>`;
  };
  const parentSegments = segments.slice(0, -1);
  const rows = [
    segments.length > 0 ? item("..", parentSegments, true) : "",
    ...folders.map((f) => item(f, [...segments, f], true)),
    ...files.map((f) => item(f, [...segments, f], false)),
  ].join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Pufflet WebDAV</title></head>` +
    `<body><h1>${xmlEscape(here)}</h1><ul>${rows}</ul></body></html>`
  );
}

// ---------------------------------------------------------------------------
// ETag + scope map
// ---------------------------------------------------------------------------

/** Same etag shape as the download/inline routes: revision unique id + size. */
export function davEtag(tgFileUniqueId: string | null, size: number): string {
  return `"${tgFileUniqueId ?? "unknown"}-${size}"`;
}

/**
 * The DAV method → API-key scope contract. Mirrors the REST scopes so one
 * key serves both interfaces: read for listings/downloads, write for
 * uploads/structural changes, delete for deletions (an rclone sync that
 * removes stale files needs it).
 */
export type DavScope = "read" | "write" | "delete";

export function methodScope(method: string): DavScope {
  switch (method) {
    case "PUT":
    case "MKCOL":
    case "MOVE":
    case "COPY":
      return "write";
    case "DELETE":
      return "delete";
    default:
      return "read";
  }
}
