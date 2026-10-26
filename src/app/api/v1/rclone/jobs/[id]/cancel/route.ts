import { jsonError, jsonOk } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { cancelJob, toJobJson } from "@/lib/rclone-service";

/** POST /api/v1/rclone/jobs/[id]/cancel — abort a queued or running sync. */
export const POST = withToken("write", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-job-cancel:${principal.userId}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const job = await cancelJob(principal.userId, id);
    return jsonOk({ job: toJobJson(job) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not cancel the job");
  }
});
