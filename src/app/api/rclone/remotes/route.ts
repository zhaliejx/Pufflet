import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { createRemote, listRemotes, toRemoteJson } from "@/lib/rclone-service";

/** GET /api/rclone/remotes — the owner's remotes, secrets masked. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-remotes:${user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    return jsonOk({ remotes: await listRemotes(user.id) });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not list remotes");
  }
}

interface CreateBody {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
}

/** POST /api/rclone/remotes — configure a new rclone remote. */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-remote-create:${user.id}:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const body = await readJson<CreateBody>(req);
    if (!body?.name || !body?.type) return jsonError("name and type are required", 400);
    const { remote, cfg } = await createRemote(user.id, { name: body.name, type: body.type, config: body.config });
    return jsonOk({ remote: toRemoteJson(remote, cfg) }, { status: 201 });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not create the remote");
  }
}
