import { getSessionUser } from "@/lib/auth";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  ShareError,
  toView,
} from "@/lib/share";
import { errorResponse, jsonError, readJson } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

interface CreateBody {
  expiresInDays?: number | null;
}

/** Create a public share link for a file. Body: { expiresInDays?: number }. */
export async function POST(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await ctx.params;
  try {
    const body = (await readJson<CreateBody>(req)) ?? {};
    const { link } = await createShareLink(user.id, id, { expiresInDays: body.expiresInDays ?? null });
    return Response.json({ link: toView(link) }, { status: 201 });
  } catch (err) {
    if (err instanceof ShareError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not create share link");
  }
}

/** List this file's share links (active + revoked, newest first). */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await ctx.params;
  try {
    const links = await listShareLinks(user.id, id);
    return Response.json({ links: links.map(toView) });
  } catch (err) {
    if (err instanceof ShareError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not list share links");
  }
}

/** Revoke a link: DELETE /api/files/{id}/share?linkId=… */
export async function DELETE(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await ctx.params;
  const linkId = new URL(req.url).searchParams.get("linkId");
  if (!linkId) return jsonError("linkId query parameter is required", 400);
  try {
    await revokeShareLink(user.id, id, linkId);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ShareError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not revoke share link");
  }
}
