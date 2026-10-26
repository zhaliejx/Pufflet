import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { browseRemote } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/rclone/remotes/[id]/browse?path= — list one directory of the remote. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-browse:${user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const path = new URL(req.url).searchParams.get("path") ?? "";
    return jsonOk(await browseRemote(user.id, id, path));
  } catch (err) {
    return rcloneErrorResponse(err, "Could not browse the remote");
  }
}
