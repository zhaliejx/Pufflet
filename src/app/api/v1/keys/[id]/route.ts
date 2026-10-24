import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { withToken } from "@/lib/v1";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withToken("admin", async (_req, principal, ctx) => {
  const { id } = await ctx.params;
  const key = await db.apiKey.findUnique({ where: { id } });
  if (!key || key.userId !== principal.userId) {
    return Response.json({ error: { message: "API key not found" } }, { status: 404 });
  }
  await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  audit("key.revoke", principal.userId, id);
  return Response.json({ ok: true, revoked: true });
});
