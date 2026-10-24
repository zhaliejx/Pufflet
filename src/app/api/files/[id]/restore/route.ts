import { getSessionUser } from "@/lib/auth";
import { restoreFile, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, unauthorized } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    await restoreFile(user.id, id);
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Restore failed");
  }
}
