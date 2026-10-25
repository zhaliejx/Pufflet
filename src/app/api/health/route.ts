import { db } from "@/lib/db";
import { telegramStatus } from "@/lib/telegram";
import { errorResponse, jsonOk } from "@/lib/api-utils";

/**
 * Health / readiness probe. Reveals capability flags only — no secrets,
 * no internal identifiers beyond a masked chat id.
 */

/** Which database backend the Prisma datasource points at. Derived from the
 *  DATABASE_URL scheme (the container entrypoint picks the matching Prisma
 *  schema the same way) — "postgresql" means the index persists externally. */
function databaseProvider(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgresql";
  if (url.startsWith("file:")) return "sqlite";
  return "unknown";
}

export async function GET() {
  try {
    let dbOk = false;
    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const tg = await telegramStatus();
    return jsonOk({
      ok: dbOk,
      checks: {
        database: dbOk ? "up" : "down",
        databaseProvider: databaseProvider(),
        telegramStorage: tg.configured ? (tg.ok ? "up" : "down") : "unconfigured",
      },
    });
  } catch (err) {
    return errorResponse(err, "Health check failed");
  }
}
