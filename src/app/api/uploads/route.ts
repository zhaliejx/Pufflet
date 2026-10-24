import { getSessionUser } from "@/lib/auth";
import { createUploadJob, ServiceError } from "@/lib/files";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { errorResponse, jsonError, readJson } from "@/lib/api-utils";

interface Body {
  filename?: string;
  size?: number;
  mimeType?: string;
  folderId?: string | null;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);

    const rl = rateLimit(`upload-create:${user.id}:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return jsonError(`Too many uploads, retry in ${rl.retryAfterSec}s`, 429);

    const body = await readJson<Body>(req);
    if (!body?.filename || body?.size === undefined) {
      return jsonError("filename and size are required", 400);
    }
    const job = await createUploadJob(
      user.id,
      {
        filename: body.filename,
        size: Number(body.size),
        mimeType: body.mimeType,
        folderId: body.folderId ?? null,
      },
      "web",
    );
    return Response.json({ uploadId: job.id, putTo: `/api/uploads/${job.id}/data` }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not create upload");
  }
}
