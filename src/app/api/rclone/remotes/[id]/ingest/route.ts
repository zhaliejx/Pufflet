import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { jsonError, jsonOk, readJson } from "@/lib/api-utils";
import { rcloneErrorResponse } from "@/lib/rclone-route";
import { ingestRemoteFile } from "@/lib/rclone-service";

type Ctx = { params: Promise<{ id: string }> };

interface IngestBody {
  path?: string;
  folderId?: string | null;
}

/**
 * POST /api/rclone/remotes/[id]/ingest — pull one remote file into Pufflet
 * (rclone cat → vault → Telegram). Synchronous; the created File row is
 * returned and its UploadJob stays pollable via /api/uploads/[id].
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const rl = rateLimit(`rclone-ingest:${user.id}:${clientIp(req)}`, 12, 60_000);
    if (!rl.allowed) return jsonError(`Too many requests, retry in ${rl.retryAfterSec}s`, 429);
    const { id } = await ctx.params;
    const body = await readJson<IngestBody>(req);
    if (!body?.path) return jsonError("path is required", 400);
    const { file, uploadId } = await ingestRemoteFile(user.id, id, body.path, body.folderId ?? null, req.signal);
    return jsonOk(
      {
        fileId: file.id,
        uploadId,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
      },
      { status: 201 },
    );
  } catch (err) {
    return rcloneErrorResponse(err, "Could not import the remote file");
  }
}
