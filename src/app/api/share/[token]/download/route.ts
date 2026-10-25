// PUBLIC share download — no login. The token in the URL is the capability.
// Streams the ORIGINAL bytes (vault containers decrypted server-side) with
// per-IP rate limiting and download counting. Inline preview is restricted
// to browser-safe types; everything else downloads as an attachment.
import { telegram } from "@/lib/telegram";
import { decodeDownloadStream } from "@/lib/vault";
import { contentDisposition, errorResponse, jsonError } from "@/lib/api-utils";
import { isPublicInlineSafe, recordShareDownload, resolveShareLink, ShareError } from "@/lib/share";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { token } = await ctx.params;

  const rl = rateLimit(`share-dl:${clientIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return jsonError("Too many requests — slow down", 429, { retryAfter: rl.retryAfterSec });
  }

  try {
    const { link, file } = await resolveShareLink(token);

    const { body, repaired } = await telegram().openDownloadStream(file.tgFileId!);
    if (repaired) {
      // Stale reference healed — persist the fresh ids (best-effort, no leak).
      const { repairFileReferences } = await import("@/lib/files");
      await repairFileReferences(file.id, repaired).catch(() => {});
    }
    const decoded = await decodeDownloadStream(body);

    const wantsInline = new URL(req.url).searchParams.get("inline") === "1";
    const inline = wantsInline && isPublicInlineSafe(file.mimeType);
    audit("share.download", null, file.id, `link ${link.id}`);
    void recordShareDownload(link.id);

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
    if (err instanceof ShareError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Share download failed");
  }
}
