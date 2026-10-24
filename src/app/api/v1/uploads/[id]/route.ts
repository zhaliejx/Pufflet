import { getUploadJob, cancelUploadJob, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withToken("read", async (_req, principal, ctx) => {
  const { id } = await ctx.params;
  try {
    const job = await getUploadJob(principal.userId, id);
    return Response.json({
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
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message } }, { status: err.status });
    }
    throw err;
  }
});

export const DELETE = withToken("write", async (_req, principal, ctx) => {
  const { id } = await ctx.params;
  try {
    await cancelUploadJob(principal.userId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message } }, { status: err.status });
    }
    throw err;
  }
});
