import { cookies } from "next/headers";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { errorResponse, jsonError, readJson } from "@/lib/api-utils";

interface Body {
  currentPassword?: string;
  newPassword?: string;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError("Sign in first", 401);

    // Brute-force guard: changing a password requires knowing the current one,
    // but we still throttle attempts per IP like the login route does.
    const rl = rateLimit(`pwchange:${clientIp(req)}`, 10, 15 * 60_000);
    if (!rl.allowed) return jsonError(`Too many attempts, retry in ${rl.retryAfterSec}s`, 429);

    const body = await readJson<Body>(req);
    const current = body?.currentPassword ?? "";
    const next = body?.newPassword ?? "";
    if (!current || !next) return jsonError("Current and new password are required", 400);
    if (next.length < 8) return jsonError("New password must be at least 8 characters", 400);
    if (next.length > 200) return jsonError("New password too long", 400);
    if (next === current) return jsonError("New password must be different from the current one", 400);

    if (!verifyPassword(current, user.passwordHash)) {
      return jsonError("Current password is incorrect", 400);
    }

    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(next), mustChangePassword: false },
    });

    // Security hygiene: every OTHER session (other devices/tabs) is signed out.
    // The current session stays alive so the user is not kicked mid-action.
    const jar = await cookies();
    const currentToken = jar.get(SESSION_COOKIE)?.value ?? "";
    await db.session.deleteMany({
      where: { userId: user.id, ...(currentToken ? { token: { not: currentToken } } : {}) },
    });

    audit("auth.password_change", user.id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Could not change password");
  }
}
