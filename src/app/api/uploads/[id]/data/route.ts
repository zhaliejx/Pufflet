import { createHash } from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { storeUploadStream, ServiceError } from "@/lib/files";
import { MAX_UPLOAD_BYTES, config } from "@/lib/config";
import { errorResponse, jsonError, jsonOk } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Raw upload sink: PUT the file bytes as the request body (no multipart).
 * Streams straight to Telegram without buffering the whole file in memory.
 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Authentication required", 401);
    const { id } = await ctx.params;

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
      return jsonError(
        `File exceeds the configured upload limit (${config.maxUploadMb} MB)`,
        413,
        { code: "PAYLOAD_TOO_LARGE" },
      );
    }
    if (!req.body) return jsonError("Request body is required", 400);

    // SHA-256 computed while streaming (no extra pass, no buffering)
    const hash = createHash("sha256");
    const hashed = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    );

    const file = await storeUploadStream(user.id, id, hashed, {
      hashStream: (s) => ({ stream: s, digest: () => hash.digest("hex") }),
    });
    return jsonOk({
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
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Upload failed");
  }
}
