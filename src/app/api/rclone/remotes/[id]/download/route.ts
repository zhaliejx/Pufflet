import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { contentDisposition, jsonError } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { statRemotePathForOwner, streamRemoteFile } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/rclone/remotes/[id]/download?path= — proxy-stream a remote file to
 * the browser (rclone cat). Size/mime come from a stat round-trip; the bytes
 * stream through the server without being buffered.
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-download:${user.id}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const path = new URL(req.url).searchParams.get("path") ?? "";
    const stat = await statRemotePathForOwner(user.id, id, path);
    const cat = await streamRemoteFile(user.id, id, path, req.signal);
    await cat.started; // clean 4xx/502 when rclone fails before the first byte
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
}
