import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { getJob, toJobJson } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/rclone/jobs/[id] — poll one sync job's live progress. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-job-get:${user.id}:${clientIp(req)}`, 120, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    return jsonOk({ job: toJobJson(await getJob(user.id, id)) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not load the job");
  }
}
