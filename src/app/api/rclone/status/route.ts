import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { rcloneStatus } from "@/lib/rclone-service";

/** GET /api/rclone/status — is the rclone binary usable on this server? */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-status:${user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    return jsonOk(await rcloneStatus());
  } catch (err) {
    return rcloneErrorResponse(err, "Could not probe rclone");
  }
}
