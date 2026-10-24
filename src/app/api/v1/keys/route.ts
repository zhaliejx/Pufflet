import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { generateApiKey, hashApiKey } from "@/lib/crypto";
import { validateScopes } from "@/lib/token-utils";
import { audit } from "@/lib/audit";
import { withToken } from "@/lib/v1";
import { readJson } from "@/lib/api-utils";

const EXPIRY_CHOICES: Record<string, number | null> = {
  never: null,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  "90d": 90 * 24 * 3600_000,
};

/** API-key management via the API itself requires the admin scope. */
export const GET = withToken("admin", async (_req, principal) => {
  const keys = await db.apiKey.findMany({
    where: { userId: principal.userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, prefix: true, scopes: true,
      expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true,
    },
  });
  return Response.json({ keys });
});

interface Body {
  name?: string;
  scopes?: string[];
  expiresIn?: keyof typeof EXPIRY_CHOICES;
}

export const POST = withToken("admin", async (req, principal) => {
  const body = await readJson<Body>(req);
  const name = (body?.name ?? "").trim();
  if (!name || name.length > 100) {
    return Response.json({ error: { message: "Key name is required (max 100 chars)" } }, { status: 400 });
  }
  const scopes = validateScopes(body?.scopes ?? []);
  if (!scopes) {
    return Response.json(
      { error: { message: "Provide at least one valid scope: read, write, delete, admin" } },
      { status: 400 },
    );
  }
  const expiryKey = body?.expiresIn && body.expiresIn in EXPIRY_CHOICES ? body.expiresIn : "never";
  const ms = EXPIRY_CHOICES[expiryKey];
  const expiresAt = ms ? new Date(Date.now() + ms) : null;

  const { token, displayPrefix } = generateApiKey(config.apiKeyPrefix);
  const key = await db.apiKey.create({
    data: {
      name,
      prefix: displayPrefix,
      hash: hashApiKey(token),
      scopes: scopes.join(","),
      userId: principal.userId,
      expiresAt,
    },
  });
  audit("key.create", principal.userId, key.id, `${name} scopes=${scopes.join(",")}`);
  return Response.json(
    {
      key: {
        id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes,
        expiresAt: key.expiresAt, createdAt: key.createdAt,
      },
      token,
      notice: "Copy this token now — it will never be shown again.",
    },
    { status: 201 },
  );
});
