import { getSessionUser } from "@/lib/auth";
import { listFiles, ListView } from "@/lib/files";
import { errorResponse, jsonError, unauthorized } from "@/lib/api-utils";

const VIEWS: ListView[] = ["folder", "recent", "starred", "trash", "search"];

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const view = (url.searchParams.get("view") ?? "folder") as ListView;
    if (!VIEWS.includes(view)) return jsonError("Invalid view", 400);
    const folderId = url.searchParams.get("folderId");
    const q = url.searchParams.get("q") ?? undefined;
    const sortParam = url.searchParams.get("sort");
    const sort = (["name", "size", "updatedAt"].includes(sortParam ?? "") ? sortParam : undefined) as
      | "name"
      | "size"
      | "updatedAt"
      | undefined;
    const dir = url.searchParams.get("dir") === "asc" ? "asc" : url.searchParams.get("dir") === "desc" ? "desc" : undefined;

    const files = await listFiles(user.id, { view, folderId, q, sort, dir });
    return Response.json({ files });
  } catch (err) {
    return errorResponse(err, "Could not list files");
  }
}
