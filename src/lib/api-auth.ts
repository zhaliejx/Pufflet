// API-token authentication for the versioned REST API (/api/v1/*).
import { db } from "@/lib/db";
import { hashApiKey } from "@/lib/crypto";
import { isKeyUsable, keyHasScope, Scope } from "@/lib/token-utils";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export interface TokenPrincipal {
  userId: string;
  keyId: string;
  scopes: Scope[];
  via: "token";
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/**
 * Validate the Bearer token and (optionally) enforce a scope.
 * Returns a principal or null; also applies rate limiting per key prefix + IP
 * and updates lastUsedAt asynchronously.
 */
export async function authenticateToken(req: Request, required?: Scope): Promise<TokenPrincipal | null> {
  const token = extractBearer(req);
  if (!token || token.length > 200) return null;

  // cheap shape check before hashing
  if (!token.startsWith("tc_live_")) return null;

  const rl = rateLimit(`api-auth:${clientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return null;

  const hash = hashApiKey(token);
  const key = await db.apiKey.findUnique({ where: { hash } });
  if (!key) return null;
  if (!isKeyUsable(key)) return null;
  if (required && !keyHasScope(key.scopes, required)) return null;

  const principal: TokenPrincipal = {
    userId: key.userId,
    keyId: key.id,
    scopes: key.scopes.split(",").map((s) => s.trim()) as Scope[],
    via: "token",
  };

  db.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return principal;
}
