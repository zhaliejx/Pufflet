// PUBLIC share endpoint — no login. Returns only the file's own display
// metadata for a valid (unrevoked, unexpired) token; never owner identity.
import { resolveShareLink, ShareError } from "@/lib/share";
import { errorResponse, jsonError } from "@/lib/api-utils";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  try {
    const { file } = await resolveShareLink(token);
    return Response.json(
      {
        name: file.name,
        size: file.size,
        mimeType: file.mimeType || "application/octet-stream",
        createdAt: file.createdAt.toISOString(),
        downloadPath: `/api/share/${token}/download`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof ShareError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Share link unavailable");
  }
}
