import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ensureDefaultUser, defaultUserActive } from "@/lib/seed";
import { ensureStateBoot } from "@/lib/state-backup";

export async function GET() {
  // Boot self-healing (once per process): restore the pinned state snapshot
  // when the database is empty, then start the auto-backup timer. No-op when
  // STATE_BACKUP="false" or Telegram is unconfigured.
  await ensureStateBoot();
  // First-run convenience: seed the default owner account (pufflet@pufflet.com
  // with a temporary password) unless SEED_DEFAULT_USER="false". Skipped
  // automatically when the restore above already brought users back.
  await ensureDefaultUser();
  const user = await getSessionUser();
  return NextResponse.json({
    needsSetup: (await db.user.count()) === 0,
    defaultUserActive: await defaultUserActive(),
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          mustChangePassword: user.mustChangePassword,
        }
      : null,
  });
}
