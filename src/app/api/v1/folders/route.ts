import { listFolders, createFolder, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

export const GET = withToken("read", async (req, principal) => {
  const all = new URL(req.url).searchParams.get("all") === "1";
  const folders = await listFolders(principal.userId, { all });
  return Response.json({ folders });
});

interface Body {
  name?: string;
  parentId?: string | null;
}

export const POST = withToken("write", async (req, principal) => {
  const body = await readJson<Body>(req);
  if (!body?.name) {
    return Response.json({ error: { message: "Folder name is required" } }, { status: 400 });
  }
  try {
    const folder = await createFolder(principal.userId, body.name, body.parentId ?? null);
    return Response.json({ folder }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
