import { createUploadJob, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

interface Body {
  filename?: string;
  size?: number;
  mimeType?: string;
  folderId?: string | null;
}

/** POST /api/v1/uploads — create an upload job (alias of POST /api/v1/files). */
export const POST = withToken("write", async (req, principal) => {
  const body = await readJson<Body>(req);
  if (!body?.filename || body?.size === undefined) {
    return Response.json({ error: { message: "filename and size are required" } }, { status: 400 });
  }
  try {
    const job = await createUploadJob(
      principal.userId,
      {
        filename: body.filename,
        size: Number(body.size),
        mimeType: body.mimeType,
        folderId: body.folderId ?? null,
      },
      "api",
    );
    return Response.json(
      { uploadId: job.id, putTo: `/api/v1/uploads/${job.id}/data` },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
