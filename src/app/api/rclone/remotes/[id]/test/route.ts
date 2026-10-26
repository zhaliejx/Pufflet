import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { testRemote } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/rclone/remotes/[id]/test — probe the remote with an lsjson on the
 * root and persist the resulting status/lastError/lastCheckedAt on the row.
 * Never throws to the client: a failed probe is a { ok: false, error } result.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-test:${user.id}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    return jsonOk(await testRemote(user.id, id));
  } catch (err) {
    return rcloneErrorResponse(err, "Could not test the remote");
  }
}
