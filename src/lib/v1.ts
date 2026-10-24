// /api/v1 route plumbing: authenticate the Bearer token, enforce the scope,
// wrap handler errors into uniform safe responses.
import { authenticateToken } from "@/lib/api-auth";
import { errorResponse, forbidden, jsonError } from "@/lib/api-utils";
import { Scope } from "@/lib/token-utils";

type Ctx = { params: Promise<Record<string, string>> };

export function withToken(
  scope: Scope | null,
  handler: (req: Request, principal: NonNullable<Awaited<ReturnType<typeof authenticateToken>>>, ctx: Ctx) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      const principal = await authenticateToken(req, scope ?? undefined);
      if (!principal) {
        // distinguish "no/bad token" from "insufficient scope"
        if (scope) {
          const unscoped = await authenticateToken(req);
          if (unscoped) return forbidden(`This operation requires the '${scope}' scope`);
        }
        return jsonError("Invalid or missing API token (use: Authorization: Bearer tc_live_...)", 401);
      }
      return await handler(req, principal, ctx);
    } catch (err) {
      return errorResponse(err, "API request failed");
    }
  };
}
