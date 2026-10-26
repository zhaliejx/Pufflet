import { jsonError, jsonOk } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { getJob, toJobJson } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/rclone/jobs/[id] — poll one sync job's live progress. */
export const GET = withToken("read", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-job-get:${principal.userId}:${clientIp(req)}`, 120, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    return jsonOk({ job: toJobJson(await getJob(principal.userId, id)) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not load the job");
  }
});
