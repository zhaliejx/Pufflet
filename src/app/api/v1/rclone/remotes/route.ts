import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { createRemote, listRemotes, toRemoteJson } from "@/lib/rclone-service";

/** GET /api/v1/rclone/remotes — list configured remotes (secrets masked). */
export const GET = withToken("read", async (req, principal) => {
  try {
    const rl = rateLimit(`v1-rclone-remotes:${principal.userId}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    return jsonOk({ remotes: await listRemotes(principal.userId) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not list remotes");
  }
});

interface CreateBody {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
}

/** POST /api/v1/rclone/remotes — configure a remote (admin scope: credentials). */
export const POST = withToken("admin", async (req, principal) => {
  try {
    const rl = rateLimit(`v1-rclone-remote-create:${principal.userId}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const body = await readJson<CreateBody>(req);
    if (!body?.name || !body?.type) return jsonError("name and type are required", 400);
    const { remote, cfg } = await createRemote(principal.userId, { name: body.name, type: body.type, config: body.config });
    return jsonOk({ remote: toRemoteJson(remote, cfg) }, { status: 201 });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not create the remote");
  }
});
