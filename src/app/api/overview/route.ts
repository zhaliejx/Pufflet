import { getSessionUser } from "@/lib/auth";
import { storageOverview } from "@/lib/files";
import { telegramStatus } from "@/lib/telegram";
import { config } from "@/lib/config";
import { errorResponse, unauthorized } from "@/lib/api-utils";

/**
 * GET /api/overview — storage dashboard payload: exact counts/bytes, file-type
 * breakdown, recent activity (audit trail), active share links, Telegram
 * status. All numbers are measured from the metadata index; nothing about
 * Telegram-side capacity is invented (the Bot API does not expose quotas).
 */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const [overview, tg] = await Promise.all([storageOverview(user.id), telegramStatus()]);
    return Response.json(
      { ...overview, limits: { maxUploadMb: config.maxUploadMb, maxDownloadMb: config.maxDownloadMb }, telegram: tg },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "Could not load overview");
  }
}
