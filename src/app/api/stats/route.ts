import { getSessionUser } from "@/lib/auth";
import { stats } from "@/lib/files";
import { telegramStatus } from "@/lib/telegram";
import { config } from "@/lib/config";
import { errorResponse, unauthorized } from "@/lib/api-utils";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const [s, tg] = await Promise.all([stats(user.id), telegramStatus()]);
    return Response.json({
      ...s,
      limits: { maxUploadMb: config.maxUploadMb, maxDownloadMb: config.maxDownloadMb },
      telegram: tg,
    });
  } catch (err) {
    return errorResponse(err, "Could not load stats");
  }
}
