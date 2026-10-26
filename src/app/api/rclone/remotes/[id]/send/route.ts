import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { sendFileToRemote } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

interface SendBody {
  fileId?: string;
  targetPath?: string;
}

/**
 * POST /api/rclone/remotes/[id]/send — stream one Pufflet file to the remote
 * (Telegram → decrypt → rclone rcat). Synchronous like a device download:
 * the request stays open until the transfer finishes.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-send:${user.id}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<SendBody>(req);
    if (!body?.fileId) return jsonError("fileId is required", 400);
    const result = await sendFileToRemote(user.id, id, body.fileId, body.targetPath ?? "", req.signal);
    return jsonOk(result);
  } catch (err) {
    return rcloneErrorResponse(err, "Could not send the file to the remote");
  }
}
