import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { listJobs } from "@/lib/rclone-service";

/** GET /api/rclone/jobs?limit=20 — recent sync jobs with live progress. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-jobs:${user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const limit = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "20", 10);
    return jsonOk({ jobs: await listJobs(user.id, Number.isFinite(limit) ? limit : 20) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not list sync jobs");
  }
}
