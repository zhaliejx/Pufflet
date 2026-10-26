import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { ingestRemoteFile } from "@/lib/rclone-service";

interface IngestBody {
  path?: string;
  folderId?: string | null;
}

/** POST /api/v1/rclone/remotes/[id]/ingest — pull one remote file into Pufflet. */
export const POST = withToken("write", async (req, principal, ctx) => {
  try {
    const rl = rateLimit(`v1-rclone-ingest:${principal.userId}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<IngestBody>(req);
    if (!body?.path) return jsonError("path is required", 400);
    const { file, uploadId } = await ingestRemoteFile(principal.userId, id, body.path, body.folderId ?? null, req.signal);
    return jsonOk({ fileId: file.id, uploadId, name: file.name, size: file.size, mimeType: file.mimeType }, { status: 201 });
  } catch (err) {
    return rcloneErrorResponse(err, "Could not import the remote file");
  }
});
