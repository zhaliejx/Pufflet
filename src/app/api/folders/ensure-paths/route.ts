import { getSessionUser } from "@/lib/auth";
import { ensureFolderPaths, ServiceError } from "@/lib/files";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

interface Body {
  parentId?: string | null;
  paths?: string[];
}

/**
 * Folder upload: find-or-create the whole relative directory tree under
 * `parentId` in one round trip. Body: { parentId?: string|null, paths: string[] }
 * where each path is "/"-joined relative directories ("Trip/day1").
 * Returns { folders: { "Trip/day1": "<id>", ... }, created, errors }.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();

    const rl = rateLimit(`folder-ensure:${user.id}:${clientIp(req)}`, 30, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);

    const body = await readJson<Body>(req);
    if (!Array.isArray(body?.paths)) {
      return jsonError("paths (array of relative directory paths) is required", 400);
    }
    const result = await ensureFolderPaths(user.id, body.parentId ?? null, body.paths);
    return jsonOk(result);
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not create the folder structure");
  }
}
