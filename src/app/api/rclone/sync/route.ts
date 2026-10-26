import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { startSyncJob, toJobJson } from "@/lib/rclone-service";

interface SyncBody {
  remoteId?: string;
  kind?: string; // "push" (Pufflet → remote) | "pull" (remote → Pufflet)
  remotePath?: string;
  folderId?: string;
}

/**
 * POST /api/rclone/sync — start a background folder sync job. The response is
 * the QUEUED job; progress lives on the row (GET /api/rclone/jobs).
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-sync:${user.id}:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const body = await readJson<SyncBody>(req);
    if (!body) return jsonError("remoteId, kind and folderId are required", 400);
    const job = await startSyncJob(user.id, body);
    return jsonOk({ job: toJobJson(job) }, { status: 201 });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not start the sync");
  }
}
