// Pure API-token logic: format validation, scope checks, expiry checks.
// Split from DB code so it can be unit-tested without a database.

export interface ApiKeyRecordLike {
  hash: string;
  prefix: string;
  scopes: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export const KNOWN_SCOPES = ["read", "write", "delete", "admin"] as const;
export type Scope = (typeof KNOWN_SCOPES)[number];

export function parseScopes(scopes: string): Scope[] {
  return scopes
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Scope => (KNOWN_SCOPES as readonly string[]).includes(s));
}

export function validateScopes(requested: string[]): Scope[] | null {
  const set = new Set(requested.map((s) => s.trim()).filter(Boolean));
  if (set.size === 0) return null;
  for (const s of set) {
    if (!(KNOWN_SCOPES as readonly string[]).includes(s)) return null;
  }
  return Array.from(set) as Scope[];
}

/** Does this key grant `required`? `admin` implies every other scope. */
export function keyHasScope(keyScopes: string, required: Scope): boolean {
  const scopes = parseScopes(keyScopes);
  return scopes.includes("admin") || scopes.includes(required);
}

export function isKeyUsable(key: ApiKeyRecordLike, now = new Date()): boolean {
  if (key.revokedAt) return false;
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
