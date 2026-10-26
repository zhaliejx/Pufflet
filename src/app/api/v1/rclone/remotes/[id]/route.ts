import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { deleteRemote, toRemoteJson, updateRemote } from "@/lib/rclone-service";

interface PatchBody {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
}

/** PATCH /api/v1/rclone/remotes/[id] — update a remote (admin scope). */
export const PATCH = withToken("admin", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-remote-update:${principal.userId}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<PatchBody>(req);
    const { remote, cfg } = await updateRemote(principal.userId, id, body ?? {});
    return jsonOk({ remote: toRemoteJson(remote, cfg) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not update the remote");
  }
});

/** DELETE /api/v1/rclone/remotes/[id] — forget a remote (admin scope). */
export const DELETE = withToken("admin", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-remote-delete:${principal.userId}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    await deleteRemote(principal.userId, id);
    return jsonOk({ deleted: true });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not delete the remote");
  }
});
