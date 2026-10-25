import { getSessionUser } from "@/lib/auth";
import { getFileForDownload, repairFileReferences, ServiceError } from "@/lib/files";
import { telegram } from "@/lib/telegram";
import { decodeDownloadStream } from "@/lib/vault";
import { contentDisposition, errorResponse, jsonError } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Stream the file's ORIGINAL bytes back to the owner. Bytes are fetched from
 * the Telegram storage chat and transparently decoded by the vault: encrypted
 * containers are decrypted + de-padded; legacy (pre-vault) files pass through
 * untouched. The response carries the real name / mime type from the DB.
 *
 * `?inline=1` serves inline (browser preview) instead of forcing a download.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await ctx.params;
  try {
    const file = await getFileForDownload(user.id, id); // authz + audit
    const { body, repaired } = await telegram().openDownloadStream(file.tgFileId!);
    if (repaired) {
      // Stale reference healed — persist the fresh ids (best-effort).
      await repairFileReferences(file.id, repaired).catch(() => {});
    }
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
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Download failed");
  }
}
