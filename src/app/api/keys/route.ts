import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { generateApiKey, hashApiKey } from "@/lib/crypto";
import { validateScopes } from "@/lib/token-utils";
import { audit } from "@/lib/audit";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { errorResponse, jsonError, jsonOk, readJson, unauthorized } from "@/lib/api-utils";

const EXPIRY_CHOICES: Record<string, number | null> = {
  never: null,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  "90d": 90 * 24 * 3600_000,
};

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const keys = await db.apiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    return jsonOk({ keys });
  } catch (err) {
    return errorResponse(err, "Could not list API keys");
  }
}

interface Body {
  name?: string;
  scopes?: string[];
  expiresIn?: keyof typeof EXPIRY_CHOICES;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();

    const rl = rateLimit(`key-create:${user.id}:${clientIp(req)}`, 10, 60 * 60_000);
    if (!rl.allowed) return jsonError("Too many key creations, retry later", 429);

    const body = await readJson<Body>(req);
    const name = (body?.name ?? "").trim();
    if (!name || name.length > 100) return jsonError("Key name is required (max 100 chars)", 400);

    const scopes = validateScopes(body?.scopes ?? []);
    if (!scopes) return jsonError("Provide at least one valid scope: read, write, delete, admin", 400);

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
        userId: user.id,
        expiresAt,
      },
    });
    audit("key.create", user.id, key.id, `${name} scopes=${scopes.join(",")}`);

    // The full token is returned EXACTLY ONCE; only its SHA-256 is stored.
    return jsonOk(
      {
        key: {
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          scopes: key.scopes,
          expiresAt: key.expiresAt,
          createdAt: key.createdAt,
        },
        token,
        notice: "Copy this token now — it will never be shown again.",
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "Could not create API key");
  }
}
