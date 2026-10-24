import { db } from "@/lib/db";
import { withToken } from "@/lib/v1";

export const GET = withToken(null, async (_req, principal) => {
  const user = await db.user.findUnique({
    where: { id: principal.userId },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  if (!user) return Response.json({ error: { message: "User not found" } }, { status: 404 });
  return Response.json({
    user,
    auth: { via: "token", keyId: principal.keyId, scopes: principal.scopes },
  });
});
