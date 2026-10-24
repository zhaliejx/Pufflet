import { destroyCurrentSession, getSessionUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api-utils";

export async function POST() {
  try {
    const user = await getSessionUser();
    await destroyCurrentSession();
    if (user) audit("auth.logout", user.id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Sign-out failed");
  }
}
