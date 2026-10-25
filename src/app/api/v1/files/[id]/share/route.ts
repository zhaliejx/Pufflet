import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  ShareError,
  toView,
} from "@/lib/share";
import { jsonError } from "@/lib/api-utils";
import { withToken } from "@/lib/v1";
import { ServiceError } from "@/lib/files";

type Ctx = { params: Promise<Record<string, string>> };

function shareErrorResponse(err: unknown): Response | null {
  if (err instanceof ShareError) {
    return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
  }
  if (err instanceof ServiceError) {
    return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
  }
  return null;
}

/** Create a public share link. Requires the "write" scope. */
export const POST = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { expiresInDays?: number | null };
    const { link } = await createShareLink(principal.userId, id, { expiresInDays: body.expiresInDays ?? null });
    return Response.json({ link: toView(link) }, { status: 201 });
  } catch (err) {
    return shareErrorResponse(err) ?? jsonError("Could not create share link", 500);
  }
});

/** List the file's share links. Requires the "read" scope. */
export const GET = withToken("read", async (_req, principal, ctx) => {
  const { id } = await ctx.params;
  try {
    const links = await listShareLinks(principal.userId, id);
    return Response.json({ links: links.map(toView) });
  } catch (err) {
    return shareErrorResponse(err) ?? jsonError("Could not list share links", 500);
  }
});

/** Revoke a link: DELETE /api/v1/files/{id}/share?linkId=… Requires "write". */
export const DELETE = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const linkId = new URL(req.url).searchParams.get("linkId");
  if (!linkId) return jsonError("linkId query parameter is required", 400);
  try {
    await revokeShareLink(principal.userId, id, linkId);
    return Response.json({ ok: true });
  } catch (err) {
    return shareErrorResponse(err) ?? jsonError("Could not revoke share link", 500);
  }
});
