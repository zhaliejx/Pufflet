import { getSessionUser } from "@/lib/auth";
import { errorResponse, unauthorized } from "@/lib/api-utils";
import { db } from "@/lib/db";

/**
 * GET /api/shares — every active share link created by the current user, with
 * the file it points at. Owner-only management surface for "which of my files
 * are shared, and who can reach them". Includes expired-but-unrevoked links
 * so the UI can show them as dead and let the owner clean up.
 */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const now = new Date();
    const rows = await db.shareLink.findMany({
      where: { createdBy: user.id, revokedAt: null },
      include: {
        file: { select: { id: true, name: true, size: true, mimeType: true, trashedAt: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const links = rows.map((l) => ({
      id: l.id,
      urlPath: `/s/${l.token}`,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt?.toISOString() ?? null,
      expired: Boolean(l.expiresAt && l.expiresAt <= now),
      downloads: l.downloads,
      lastDownloadAt: l.lastDownloadAt?.toISOString() ?? null,
      file: l.file,
    }));
    return Response.json({ links }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "Could not list share links");
  }
}
