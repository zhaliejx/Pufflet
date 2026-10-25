import { getFileForDownload, ServiceError } from "@/lib/files";
import { telegram } from "@/lib/telegram";
import { decodeDownloadStream } from "@/lib/vault";
import { contentDisposition } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";

type Ctx = { params: Promise<Record<string, string>> };

/**
 * REST API download: streams the file's ORIGINAL bytes (vault containers are
 * decrypted transparently; pre-vault files pass through). Requires the
 * "read" scope. `?inline=1` serves inline instead of attachment.
 */
export const GET = withToken("read", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  try {
    const file = await getFileForDownload(principal.userId, id); // authz + audit
    const { body } = await telegram().openDownloadStream(file.tgFileId!);
    const decoded = await decodeDownloadStream(body);
    const inline = new URL(req.url).searchParams.get("inline") === "1";
    return new Response(decoded, {
      headers: {
        "content-type": file.mimeType || "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.name),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
