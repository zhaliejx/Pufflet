// WebDAV mount — "Pufflet as a remote" (Pages Router API route).
// Serves the key owner's storage at /api/dav/... so EXTERNAL rclone clients
// (webdav backend, vendor=other) or any WebDAV client can browse, upload,
// download and sync against Pufflet. Auth: HTTP Basic where the password is
// an API key; scopes enforced per method (see lib/webdav.ts methodScope).
//
// WHY PAGES ROUTER: the App Router's route handlers only dispatch the seven
// methods in next/dist/server/web/http.js (GET/HEAD/OPTIONS/POST/PUT/DELETE/
// PATCH) and answer every other method with a bare 400 — PROPFIND, MKCOL,
// MOVE and COPY can never reach an app route. Pages API routes dispatch ALL
// methods to the default export, which is exactly what WebDAV needs.
import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  davGuard,
  davSegmentsOr400,
  davDepth,
  davGetOrHead,
  davPropfind,
  davPut,
  davMkcol,
  davDelete,
  davMove,
  davCopy,
  davErrorResponse,
  davText,
} from "@/lib/webdav-server";
import { methodScope } from "@/lib/webdav";

export const config = {
  api: {
    // Raw body access for PUT uploads and PROPFIND bodies — never buffered.
    bodyParser: false,
  },
};

const DAV_ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY";

function segmentsOf(req: NextApiRequest): string[] {
  const raw = req.query.path;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw !== "") return [raw];
  return [];
}

/**
 * Wrap the Node request into a real web Request so every webdav-server
 * helper can keep speaking the fetch API (Headers#get, body streams).
 * The URL is only used for construction — path segments come from the
 * router params, never from parsing this URL.
 */
function asWebRequest(req: NextApiRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://internal${req.url ?? "/"}`;
  if ((req.method ?? "GET") === "PUT") {
    return new Request(url, {
      method: "PUT",
      headers,
      body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
      // undici requires half-duplex for streaming request bodies
      duplex: "half",
    } as RequestInit);
  }
  return new Request(url, { method: req.method ?? "GET", headers });
}

/** Bridge a web Response (webdav-server) onto the Node response object. */
function sendWebResponse(res: NextApiResponse, web: Response): void {
  res.statusCode = web.status;
  const keepLength = web.headers.get("content-length");
  web.headers.forEach((value, key) => {
    if (key === "content-length") return;
    res.setHeader(key, value);
  });
  if (keepLength) res.setHeader("content-length", keepLength);
  if (!web.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(web.body as import("stream/web").ReadableStream);
  nodeStream.on("error", () => res.destroy());
  nodeStream.pipe(res);
}

function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const web = asWebRequest(req);
  try {
    if (method === "OPTIONS") {
      return sendWebResponse(
        res,
        new Response(null, {
          status: 200,
          headers: { dav: "1", allow: DAV_ALLOW, "ms-author-via": "DAV", "content-length": "0" },
        }),
      );
    }
    if (method === "LOCK") {
      // WebDAV Class 1 only — no locking (rclone never locks).
      return sendWebResponse(res, davText(415, "Locking is not supported on this server\n"));
    }
    if (method === "UNLOCK") return sendWebResponse(res, davText(204, ""));

    const scope = methodScope(method);
    const guard = await davGuard(web, scope);
    if ("response" in guard) return sendWebResponse(res, guard.response);
    const principal = guard.principal;
    const seg = davSegmentsOr400(segmentsOf(req));
    if ("response" in seg) return sendWebResponse(res, seg.response);

    switch (method) {
      case "PROPFIND": {
        const out = await davPropfind(principal.userId, seg.segments, davDepth(web));
        return sendWebResponse(res, out);
      }
      case "GET":
      case "HEAD": {
        const out = await davGetOrHead(principal.userId, web, seg.segments, method);
        return sendWebResponse(res, out);
      }
      case "PUT": {
        const declared = Number(web.headers.get("content-length") ?? "0") || 0;
        const out = await davPut(
          principal.userId,
          seg.segments,
          web.body,
          web.headers.get("content-type"),
          declared,
        );
        return sendWebResponse(res, out);
      }
      case "MKCOL": {
        const out = await davMkcol(principal.userId, seg.segments);
        return sendWebResponse(res, out);
      }
      case "DELETE": {
        const out = await davDelete(principal.userId, seg.segments);
        return sendWebResponse(res, out);
      }
      case "MOVE": {
        const out = await davMove(principal.userId, seg.segments, web);
        return sendWebResponse(res, out);
      }
      case "COPY": {
        const out = await davCopy(principal.userId, seg.segments, web);
        return sendWebResponse(res, out);
      }
      default:
        return sendWebResponse(
          res,
          davText(405, `Method not allowed. Allowed: ${DAV_ALLOW}\n`, { allow: DAV_ALLOW }),
        );
    }
  } catch (err) {
    if (isResponse(err)) return sendWebResponse(res, err);
    return sendWebResponse(res, davErrorResponse(err, "WebDAV operation failed"));
  }
}
