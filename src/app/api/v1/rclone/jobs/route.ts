import { jsonError, jsonOk } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { listJobs } from "@/lib/rclone-service";

/** GET /api/v1/rclone/jobs?limit=20 — recent sync jobs with live progress. */
export const GET = withToken("read", async (req, principal) => {
  try {
    const rl = rateLimit(`v1-rclone-jobs:${principal.userId}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const limit = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "20", 10);
    return jsonOk({ jobs: await listJobs(principal.userId, Number.isFinite(limit) ? limit : 20) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not list sync jobs");
  }
});
