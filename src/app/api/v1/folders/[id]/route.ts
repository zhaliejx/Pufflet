import { moveFolder, purgeFolder, renameFolder, restoreFolder, trashFolder, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

type Ctx = { params: Promise<{ id: string }> };

interface Body {
  name?: string;
  parentId?: string | null;
}

export const PATCH = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<Body>(req);
  if (!body) return Response.json({ error: { message: "Invalid body" } }, { status: 400 });
  if (body.name !== undefined && body.parentId !== undefined) {
    return Response.json({ error: { message: "Rename and move must be sent separately" } }, { status: 400 });
  }
  try {
    if (body.name !== undefined) {
      return Response.json({ folder: await renameFolder(principal.userId, id, body.name) });
    }
    if (body.parentId !== undefined) {
      return Response.json({ folder: await moveFolder(principal.userId, id, body.parentId) });
    }
    return Response.json({ error: { message: "Nothing to update" } }, { status: 400 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});

export const DELETE = withToken("delete", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";
  try {
    if (permanent) {
      const result = await purgeFolder(principal.userId, id);
      return Response.json({ ok: true, ...result });
    }
    const result = await trashFolder(principal.userId, id);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});

export const POST = withToken("write", async (req, principal, ctx) => {
  const { id } = await ctx.params;
  if (new URL(req.url).searchParams.get("action") !== "restore") {
    return Response.json({ error: { message: "Unknown action" } }, { status: 400 });
  }
  try {
    await restoreFolder(principal.userId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
