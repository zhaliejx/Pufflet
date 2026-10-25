import { getSessionUser } from "@/lib/auth";
import { restoreFromBackup } from "@/lib/state-backup";
import { audit } from "@/lib/audit";
import { jsonError, jsonOk, unauthorized } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/ratelimit";

/**
 * Restore the index from a previous backup, overwriting the CURRENT database
 * contents (Settings -> Data safety -> Restore). Owner session required and
 * rate-limited — this is a deliberate, destructive-by-design recovery path:
 * source "pinned" = the hot snapshot; source "checkpoint" = a recorded cold
 * checkpoint (messageId validated against the stored ring).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const rl = rateLimit(`backup-restore:${clientIp(req)}`, 3, 10 * 60_000);
  if (!rl.allowed) return jsonError(`Too many restores, retry in ${rl.retryAfterSec}s`, 429);

  let body: { source?: string; messageId?: string };
  try {
    body = (await req.json()) as { source?: string; messageId?: string };
  } catch {
    body = {};
  }
  const source = body.source === "checkpoint" ? "checkpoint" : body.source === "pinned" ? "pinned" : null;
  if (!source) return jsonError('body must be {"source":"pinned"} or {"source":"checkpoint","messageId":"..."}', 400);

  const res = await restoreFromBackup(source, body.messageId);
  if (!res.ok) return jsonError(res.error, 502);

  audit("backup.restore", user.id, source === "checkpoint" ? body.messageId : "pinned", `restored snapshot exported ${res.exportedAt}`);
  return jsonOk({ ok: true, source, exportedAt: res.exportedAt, counts: res.counts });
}
