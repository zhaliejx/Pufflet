import { createHash } from "node:crypto";
import { storeUploadStream, ServiceError } from "@/lib/files";
import { MAX_UPLOAD_BYTES, config } from "@/lib/config";
import { withToken } from "@/lib/v1";

type Ctx = { params: Promise<{ id: string }> };

/** PUT raw file bytes; streams to Telegram, then records the File row. */
export const PUT = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: { message: `File exceeds the configured upload limit (${config.maxUploadMb} MB)`, code: "PAYLOAD_TOO_LARGE" } },
      { status: 413 },
    );
  }
  if (!req.body) {
    return Response.json({ error: { message: "Request body is required" } }, { status: 400 });
  }
  try {
    const hash = createHash("sha256");
    const hashed = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    const file = await storeUploadStream(principal.userId, id, hashed, {
      hashStream: (s) => ({ stream: s, digest: () => hash.digest("hex") }),
    });
    return Response.json({
      file: {
        id: file.id,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        folderId: file.folderId,
        createdAt: file.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
