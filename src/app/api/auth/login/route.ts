import { authenticate, createSession, setSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp, rateLimit, rateLimitPeek, rateLimitReset } from "@/lib/ratelimit";
import { errorResponse, jsonError, readJson } from "@/lib/api-utils";

interface Body {
  email?: string;
  password?: string;
}

const MAX_LOGIN_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60_000;

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const failKey = `login-fail:${ip}`;
    const body = await readJson<Body>(req);
    const email = (body?.email ?? "").trim();
    const password = body?.password ?? "";
    if (!email || !password) return jsonError("Email and password are required", 400);

    // Verify FIRST, throttle failures only: correct credentials always sign in
    // (and reset the counter), so a burst of bad guesses can never lock the
    // real owner out — brute-force protection only binds to wrong passwords.
    const user = await authenticate(email, password);
    if (!user) {
      const peek = rateLimitPeek(failKey);
      if (peek.limited) {
        return jsonError(`Too many sign-in attempts. Retry in ${peek.retryAfterSec}s`, 429);
      }
      const rl = rateLimit(failKey, MAX_LOGIN_FAILURES, FAILURE_WINDOW_MS);
      audit("auth.login_failed", null, undefined, ip);
      if (!rl.allowed) {
        return jsonError(`Too many sign-in attempts. Retry in ${rl.retryAfterSec}s`, 429);
      }
      return jsonError("Invalid email or password", 401);
    }
    rateLimitReset(failKey);
    const { token, expiresAt } = await createSession(user.id);
    await setSessionCookie(token, expiresAt);
    audit("auth.login", user.id);
    return Response.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    return errorResponse(err, "Sign-in failed");
  }
}
