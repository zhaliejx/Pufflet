import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { cancelJob, toJobJson } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/rclone/jobs/[id]/cancel — abort a queued or running sync. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-job-cancel:${user.id}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const job = await cancelJob(user.id, id);
    return jsonOk({ job: toJobJson(job) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not cancel the job");
  }
}
