import { getSessionUser } from "@/lib/auth";
import { emptyTrash, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, unauthorized } from "@/lib/api-utils";

/** POST /api/trash/empty — permanently delete everything in the trash. */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    // Confirm query param guards against accidental calls from scripts
    if (new URL(req.url).searchParams.get("confirm") !== "yes") {
      return jsonError("Add ?confirm=yes to permanently empty the trash", 400);
    }
    const result = await emptyTrash(user.id);
    return jsonOk(result);
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not empty trash");
  }
}
