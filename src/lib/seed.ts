// First-run seeding -----------------------------------------------------------
// Creates the well-known default owner account so a fresh Pufflet instance is
// immediately usable (e.g. on Vercel where you cannot run interactive setup).
//
//   email:    pufflet@pufflet.com
//   password: pufflet            (TEMPORARY — mustChangePassword is set, the UI
//                                  nags until the password is changed in
//                                  Settings -> Account)
//
// The password is 7 chars on purpose (it is a login-and-change-it throwaway),
// so seeding bypasses the 8+ char API validation on purpose. Disable with
// SEED_DEFAULT_USER="false" to keep the original first-run setup flow.
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";

export const DEFAULT_USER_EMAIL = "pufflet@pufflet.com";
export const DEFAULT_USER_PASSWORD = "pufflet";
const DEFAULT_USER_NAME = "Pufflet Owner";

export function seedingEnabled(): boolean {
  return process.env.SEED_DEFAULT_USER !== "false";
}

/** Idempotent: creates the default owner only when the users table is empty. */
export async function ensureDefaultUser(): Promise<void> {
  if (!seedingEnabled()) return;
  try {
    const count = await db.user.count();
    if (count > 0) return;
    await db.user.create({
      data: {
        email: DEFAULT_USER_EMAIL,
        passwordHash: hashPassword(DEFAULT_USER_PASSWORD),
        name: DEFAULT_USER_NAME,
        role: "OWNER",
        mustChangePassword: true,
      },
    });
  } catch {
    // Never let seeding break auth state (e.g. concurrent request won the race,
    // or the DB is briefly unavailable). Setup/login still work normally.
  }
}

/**
 * True while the default account still uses its temporary password — the login
 * screen uses this to show the "first run" credentials hint, and it disappears
 * automatically once the password has been changed.
 */
export async function defaultUserActive(): Promise<boolean> {
  if (!seedingEnabled()) return false;
  try {
    const user = await db.user.findUnique({ where: { email: DEFAULT_USER_EMAIL } });
    return Boolean(user?.mustChangePassword);
  } catch {
    return false;
  }
}
