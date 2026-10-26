import { jsonError, jsonOk } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { browseRemote } from "@/lib/rclone-service";

/** GET /api/v1/rclone/remotes/[id]/browse?path= — list a remote directory. */
export const GET = withToken("read", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-browse:${principal.userId}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const path = new URL(req.url).searchParams.get("path") ?? "";
    return jsonOk(await browseRemote(principal.userId, id, path));
  } catch (err) {
    return rcloneErrorResponse(err, "Could not browse the remote");
  }
});
