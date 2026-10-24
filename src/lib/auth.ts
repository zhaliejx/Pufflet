// Session-based auth for the website (httpOnly cookie + DB-backed sessions).
// Every server-side route re-derives the user from the cookie — never trust
// client-sent identity.
import { cookies } from "next/headers";
import { users } from "@prisma/client";
import { config } from "@/lib/config";
import { generateToken, hashPassword, verifyPassword } from "@/lib/crypto";
import { db as prisma } from "@/lib/db";

type User = users;
type Session = sessions;

export const SESSION_COOKIE = config.sessionCookie;

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(48);
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(new Date(0)), expires: new Date(0) });
}

/** Resolve the current user from the session cookie, or null. */
export async function getSessionUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return row.user;
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } }).catch(() => {});
  }
  await clearSessionCookie();
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    // burn comparable time to blunt user-enumeration timing
    verifyPassword(password, "scrypt$16384$8$1$00$00");
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export async function createUser(email: string, password: string, name: string | null, role = "OWNER"): Promise<User> {
  return prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash: hashPassword(password),
      name,
      role,
    },
  });
}

export async function userCount(): Promise<number> {
  return prisma.user.count();
}

export type { User, Session };
