import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sendFileToRemote } from "@/lib/rclone-service";

interface SendBody {
  fileId?: string;
  targetPath?: string;
}

/** POST /api/v1/rclone/remotes/[id]/send — stream a Pufflet file to the remote. */
export const POST = withToken("write", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-send:${principal.userId}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<SendBody>(req);
    if (!body?.fileId) return jsonError("fileId is required", 400);
    const result = await sendFileToRemote(principal.userId, id, body.fileId, body.targetPath ?? "", req.signal);
    return jsonOk(result);
  } catch (err) {
    return rcloneErrorResponse(err, "Could not send the file to the remote");
  }
});
