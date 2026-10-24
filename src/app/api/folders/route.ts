import { getSessionUser } from "@/lib/auth";
import { breadcrumbs, listFolders } from "@/lib/files";
import { createFolder, ServiceError } from "@/lib/files";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const all = url.searchParams.get("all") === "1";
    const folders = await listFolders(user.id, { all });
    const breadcrumbId = url.searchParams.get("breadcrumbOf");
    const trail = breadcrumbId ? await breadcrumbs(user.id, breadcrumbId) : [];
    return jsonOk({ folders, trail });
  } catch (err) {
    return errorResponse(err, "Could not list folders");
  }
}

interface Body {
  name?: string;
  parentId?: string | null;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const body = await readJson<Body>(req);
    if (!body?.name) return jsonError("Folder name is required", 400);
    const folder = await createFolder(user.id, body.name, body.parentId ?? null);
    return jsonOk({ folder }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return errorResponse(err, "Could not create folder");
  }
}
