import { getSessionUser } from "@/lib/auth";
import { bulkFolderAction, BulkFolderAction, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

interface Body {
  action?: BulkFolderAction;
  ids?: string[];
}

const ACTIONS: BulkFolderAction[] = ["trash", "restore", "purge"];

/**
 * POST /api/folders/bulk — multi-select folder operations.
 * Body: { action: "trash"|"restore"|"purge", ids: string[] }
 * Restores run shallowest-first so parents come back before their children.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const body = await readJson<Body>(req);
    if (!body?.action || !ACTIONS.includes(body.action)) {
      return jsonError("Invalid or missing action", 400);
    }
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((i) => typeof i !== "string")) {
      return jsonError("ids must be a non-empty array of folder ids", 400);
    }
    const result = await bulkFolderAction(user.id, body.action, body.ids);
    return jsonOk({ ok: result.failed === 0, ...result });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Bulk operation failed");
  }
}
