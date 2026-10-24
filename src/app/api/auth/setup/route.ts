import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createUser, createSession, setSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { errorResponse, jsonError, readJson } from "@/lib/api-utils";

interface Body {
  email?: string;
  password?: string;
  name?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  try {
    // one-time setup — but still rate-limit to avoid abuse of a public endpoint
    const rl = rateLimit(`setup:${clientIp(req)}`, 5, 15 * 60_000);
    if (!rl.allowed) return jsonError("Too many attempts, try later", 429);

    if ((await db.user.count()) > 0) {
      return jsonError("Setup already completed. Sign in instead.", 409);
    }
    const body = await readJson<Body>(req);
    const email = body?.email?.toLowerCase().trim() ?? "";
    const password = body?.password ?? "";
    const name = body?.name?.trim() || null;
    if (!EMAIL_RE.test(email) || email.length > 200) return jsonError("Enter a valid email address", 400);
    if (password.length < 8) return jsonError("Password must be at least 8 characters", 400);
    if (password.length > 200) return jsonError("Password too long", 400);

    const user = await createUser(email, password, name, "OWNER");
    const { token, expiresAt } = await createSession(user.id);
    await setSessionCookie(token, expiresAt);
    audit("auth.setup", user.id);
    return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    return errorResponse(err, "Setup failed");
  }
}
