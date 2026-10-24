import { db } from "@/lib/db";
import { telegramStatus } from "@/lib/telegram";
import { errorResponse, jsonOk } from "@/lib/api-utils";

/**
 * Health / readiness probe. Reveals capability flags only — no secrets,
 * no internal identifiers beyond a masked chat id.
 */
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
        telegramStorage: tg.configured ? (tg.ok ? "up" : "down") : "unconfigured",
      },
    });
  } catch (err) {
    return errorResponse(err, "Health check failed");
  }
}
