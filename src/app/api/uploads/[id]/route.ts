import { getSessionUser } from "@/lib/auth";
import { cancelUploadJob, getUploadJob, ServiceError } from "@/lib/files";
import { abortRemoteUpload } from "@/lib/remote-import";
import { errorResponse, jsonError, jsonOk, unauthorized } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const job = await getUploadJob(user.id, id);
    return jsonOk({
      id: job.id,
      status: job.status,
      filename: job.filename,
      size: job.size,
      error: job.error,
      fileId: job.fileId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status);
    return errorResponse(err, "Could not load upload job");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    await cancelUploadJob(user.id, id);
    // If a Google Drive import is streaming for this job, stop it server-side.
    abortRemoteUpload(id);
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status);
    return errorResponse(err, "Could not cancel upload");
  }
}
