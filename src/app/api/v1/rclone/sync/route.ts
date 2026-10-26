import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { startSyncJob, toJobJson } from "@/lib/rclone-service";

interface SyncBody {
  remoteId?: string;
  kind?: string; // "push" | "pull"
  remotePath?: string;
  folderId?: string;
}

/**
 * POST /api/v1/rclone/sync — start a background folder sync job (write scope).
 * Poll the job via GET /api/v1/rclone/jobs.
 */
export const POST = withToken("write", async (req, principal) => {
  try {
    const rl = rateLimit(`v1-rclone-sync:${principal.userId}:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const body = await readJson<SyncBody>(req);
    if (!body) return jsonError("remoteId, kind and folderId are required", 400);
    const job = await startSyncJob(principal.userId, body);
    return jsonOk({ job: toJobJson(job) }, { status: 201 });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not start the sync");
  }
});
