import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { errorResponse, jsonError, jsonOk, unauthorized } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const key = await db.apiKey.findUnique({ where: { id } });
    if (!key || key.userId !== user.id) return jsonError("API key not found", 404);
    await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    audit("key.revoke", user.id, id);
    return jsonOk({ ok: true, revoked: true });
  } catch (err) {
    return errorResponse(err, "Could not revoke API key");
  }
}
