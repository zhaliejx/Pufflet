import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { deleteRemote, toRemoteJson, updateRemote } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

interface PatchBody {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
}

/** PATCH /api/rclone/remotes/[id] — rename / change backend / update fields. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-remote-update:${user.id}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<PatchBody>(req);
    const { remote, cfg } = await updateRemote(user.id, id, body ?? {});
    return jsonOk({ remote: toRemoteJson(remote, cfg) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not update the remote");
  }
}

/** DELETE /api/rclone/remotes/[id] — forget the remote (and its encrypted credentials). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-remote-delete:${user.id}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    await deleteRemote(user.id, id);
    return jsonOk({ deleted: true });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not delete the remote");
  }
}
