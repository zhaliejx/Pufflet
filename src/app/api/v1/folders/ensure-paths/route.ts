import { ensureFolderPaths, ServiceError } from "@/lib/files";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

interface Body {
  parentId?: string | null;
  paths?: string[];
}

// v1 (API key): find-or-create a relative directory tree under `parentId` —
// the same primitive the web UI uses for folder uploads.
export const POST = withToken("write", async (req, principal) => {
  const body = await readJson<Body>(req);
  if (!Array.isArray(body?.paths)) {
    return Response.json(
      { error: { message: "paths (array of relative directory paths) is required" } },
      { status: 400 },
    );
  }
  try {
    const result = await ensureFolderPaths(principal.userId, body.parentId ?? null, body.paths);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    }
    throw err;
  }
});
