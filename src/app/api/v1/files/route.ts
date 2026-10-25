import { listFiles, createUploadJob, ListView, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

const VIEWS: ListView[] = ["folder", "recent", "starred", "trash", "search"];

export const GET = withToken("read", async (req, principal) => {
  const url = new URL(req.url);
  const view = (url.searchParams.get("view") ?? "folder") as ListView;
  if (!VIEWS.includes(view)) {
    return Response.json({ error: { message: "Invalid view" } }, { status: 400 });
  }
  const intParam = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const { files, total } = await listFiles(principal.userId, {
    view,
    folderId: url.searchParams.get("folderId"),
    q: url.searchParams.get("q") ?? undefined,
    sort: (url.searchParams.get("sort") as "name" | "size" | "updatedAt" | null) ?? undefined,
    dir: (url.searchParams.get("dir") as "asc" | "desc" | null) ?? undefined,
    limit: intParam("limit"),
    offset: intParam("offset"),
  });
  return Response.json(
    { files, total },
    { headers: { "cache-control": "no-store" } },
  );
});

interface Body {
  filename?: string;
  size?: number;
  mimeType?: string;
  folderId?: string | null;
}

/**
 * POST /api/v1/files — create an upload job.
 * Then PUT the raw bytes to /api/v1/uploads/{uploadId}/data.
 * The file becomes visible (status READY) only after Telegram storage
 * succeeds and the metadata row is committed.
 */
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
