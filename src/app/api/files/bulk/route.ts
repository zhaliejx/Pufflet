import { getSessionUser } from "@/lib/auth";
import { bulkFileAction, BulkFileAction, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

interface Body {
  action?: BulkFileAction;
  ids?: string[];
  folderId?: string | null;
}

const ACTIONS: BulkFileAction[] = ["trash", "restore", "purge", "star", "unstar", "move"];

/**
 * POST /api/files/bulk — multi-select operations.
 * Body: { action: "trash"|"restore"|"purge"|"star"|"unstar"|"move", ids: string[], folderId? }
 * Per-item best-effort: one failing id never blocks the others; failures are
 * reported individually.
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
      return jsonError("ids must be a non-empty array of file ids", 400);
    }
    const result = await bulkFileAction(user.id, body.action, body.ids, body.folderId ?? null);
    return jsonOk({ ok: result.failed === 0, ...result });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Bulk operation failed");
  }
}
