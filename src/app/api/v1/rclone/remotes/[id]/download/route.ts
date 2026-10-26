import { jsonError } from "@/lib/api-utils";
import { contentDisposition } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { statRemotePathForOwner, streamRemoteFile } from "@/lib/rclone-service";

/**
 * GET /api/v1/rclone/remotes/[id]/download?path= — proxy-stream a remote file
 * to the API client (rclone cat). `read` scope: downloads read remote bytes.
 */
export const GET = withToken("read", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-download:${principal.userId}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const path = new URL(req.url).searchParams.get("path") ?? "";
    const stat = await statRemotePathForOwner(principal.userId, id, path);
    const cat = await streamRemoteFile(principal.userId, id, path, req.signal);
    await cat.started;
    return new Response(cat.stream, {
      headers: {
        "content-type": stat?.mimeType && stat.mimeType.length <= 100 ? stat.mimeType : "application/octet-stream",
        ...(stat ? { "content-length": String(stat.size) } : {}),
        "content-disposition": contentDisposition("attachment", stat?.name ?? path.split("/").pop() ?? "file"),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not download the remote file");
  }
});
