import { getSessionUser } from "@/lib/auth";
import { moveFolder, purgeFolder, renameFolder, restoreFolder, trashFolder, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  name?: string;
  parentId?: string | null;
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const body = await readJson<Body>(req);
    if (!body) return jsonError("Invalid request body", 400);
    if (body.name !== undefined && body.parentId !== undefined) {
      return jsonError("Rename and move must be sent separately", 400);
    }
    if (body.name !== undefined) {
      const folder = await renameFolder(user.id, id, body.name);
      return jsonOk({ folder });
    }
    if (body.parentId !== undefined) {
      const folder = await moveFolder(user.id, id, body.parentId);
      return jsonOk({ folder });
    }
    return jsonError("Nothing to update", 400);
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Update failed");
  }
}

/** DELETE = trash subtree. DELETE ?permanent=1 = purge subtree from trash. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const permanent = new URL(req.url).searchParams.get("permanent") === "1";
    if (permanent) {
      const result = await purgeFolder(user.id, id);
      return jsonOk({ ok: true, ...result });
    }
    const result = await trashFolder(user.id, id);
    return jsonOk({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Delete failed");
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const action = new URL(req.url).searchParams.get("action");
    if (action === "restore") {
      await restoreFolder(user.id, id);
      return jsonOk({ ok: true });
    }
    return jsonError("Unknown action", 400);
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Folder action failed");
  }
}
