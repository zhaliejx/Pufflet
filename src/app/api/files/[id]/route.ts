import { getSessionUser } from "@/lib/auth";
import {
  moveFile,
  purgeFile,
  renameFile,
  setStar,
  trashFile,
  ServiceError,
} from "@/lib/files";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  name?: string;
  folderId?: string | null;
  starred?: boolean;
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const { db } = await import("@/lib/db");
    const file = await db.file.findUnique({ where: { id } });
    if (!file || file.ownerId !== user.id) return jsonError("File not found", 404);
    return jsonOk({
      file: { ...file, tgFileId: undefined, tgFileUniqueId: undefined, tgChatId: file.tgChatId ? "set" : null, tgMessageId: file.tgMessageId ? "set" : null },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const body = await readJson<Body>(req);
    if (!body) return jsonError("Invalid request body", 400);

    if (body.name !== undefined && body.folderId !== undefined) {
      return jsonError("Rename and move must be sent separately", 400);
    }
    let file;
    if (body.name !== undefined) file = await renameFile(user.id, id, body.name);
    else if (body.folderId !== undefined) file = await moveFile(user.id, id, body.folderId);
    else if (body.starred !== undefined) file = await setStar(user.id, id, Boolean(body.starred));
    else return jsonError("Nothing to update", 400);
    return jsonOk({ file });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Update failed");
  }
}

/** DELETE = move to trash. DELETE ?permanent=1 = irreversible purge. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const permanent = new URL(req.url).searchParams.get("permanent") === "1";
    if (permanent) {
      await purgeFile(user.id, id);
      return jsonOk({ ok: true, purged: true });
    }
    await trashFile(user.id, id);
    return jsonOk({ ok: true, trashed: true });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Delete failed");
  }
}
