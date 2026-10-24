import { db } from "@/lib/db";
import { moveFile, purgeFile, renameFile, setStar, trashFile, restoreFile, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  name?: string;
  folderId?: string | null;
  starred?: boolean;
}

export const GET = withToken("read", async (_req, principal, ctx) => {
  const { id } = await ctx.params;
  const file = await db.file.findUnique({ where: { id } });
  if (!file || file.ownerId !== principal.userId) {
    return Response.json({ error: { message: "File not found" } }, { status: 404 });
  }
  return Response.json({
    file: {
      id: file.id,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      status: file.status,
      starred: file.starred,
      folderId: file.folderId,
      trashedAt: file.trashedAt,
      sha256: file.sha256,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    },
  });
});

export const PATCH = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<Body>(req);
  if (!body) return Response.json({ error: { message: "Invalid body" } }, { status: 400 });
  if (body.name !== undefined && body.folderId !== undefined) {
    return Response.json({ error: { message: "Rename and move must be sent separately" } }, { status: 400 });
  }
  try {
    if (body.name !== undefined) {
      return Response.json({ file: await renameFile(principal.userId, id, body.name) });
    }
    if (body.folderId !== undefined) {
      return Response.json({ file: await moveFile(principal.userId, id, body.folderId) });
    }
    if (body.starred !== undefined) {
      return Response.json({ file: await setStar(principal.userId, id, Boolean(body.starred)) });
    }
    return Response.json({ error: { message: "Nothing to update" } }, { status: 400 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});

/** DELETE = trash (write scope). DELETE ?permanent=1 = purge (delete scope). */
export const DELETE = withToken(null, async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";
  try {
    if (permanent) {
      await purgeFile(principal.userId, id);
      return Response.json({ ok: true, purged: true });
    }
    // trash requires delete scope (soft delete is destructive-ish); the
    // withToken wrapper already validated *a* token — enforce delete here:
    const { keyHasScope } = await import("@/lib/token-utils");
    if (!keyHasScope(principal.scopes.join(","), "delete")) {
      return Response.json({ error: { message: "This operation requires the 'delete' scope" } }, { status: 403 });
    }
    await trashFile(principal.userId, id);
    return Response.json({ ok: true, trashed: true });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});

export const POST = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action");
  if (action !== "restore") {
    return Response.json({ error: { message: "Unknown action" } }, { status: 400 });
  }
  try {
    await restoreFile(principal.userId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
