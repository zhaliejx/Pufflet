// Remote import endpoint (web session auth) -----------------------------------
// POST /api/uploads/remote { url, folderId?, probe? }
//
// probe=true  → resolve the Google Drive link only (metadata, no download).
//               Used by the dialog for instant validation feedback.
// default     → start a real import: creates the upload job, returns
//               immediately, and the transfer continues in the background
//               (client polls GET /api/uploads/<id> like any other upload).

import { getSessionUser } from "@/lib/auth";
import { ServiceError } from "@/lib/files";
import { fetchDriveFile, parseDriveLink } from "@/lib/gdrive";
import { startRemoteImport } from "@/lib/remote-import";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { errorResponse, jsonError, jsonOk, readJson } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  url?: string;
  folderId?: string | null;
  probe?: boolean;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);

    const rl = rateLimit(`remote-import:${user.id}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many imports, retry in ${rl.retryAfterSec}s`, 429);

    const body = await readJson<Body>(req);
    if (!body?.url || typeof body.url !== "string") return jsonError("url is required", 400);

    const parsed = parseDriveLink(body.url);
    if (!parsed.ok) return jsonError(parsed.error, 400, { code: "BAD_LINK" });

    if (body.probe) {
      const ac = new AbortController();
      try {
        const meta = await fetchDriveFile(parsed.fileId, ac.signal);
        ac.abort(); // metadata only — drop the download connection
        return jsonOk({ fileId: parsed.fileId, name: meta.name, size: meta.size, mimeType: meta.mimeType });
      } catch (err) {
        return remoteImportError(err, "Could not read that Google Drive link");
      }
    }

    const started = await startRemoteImport(user.id, body.url, body.folderId ?? null);
    return jsonOk(started, { status: 201 });
  } catch (err) {
    return remoteImportError(err, "Could not import from Google Drive");
  }
}

function remoteImportError(err: unknown, fallback: string) {
  if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
  return errorResponse(err, fallback);
}
