import { getSessionUser } from "@/lib/auth";
import { flushStateBackup, backupStatus } from "@/lib/state-backup";
import { audit } from "@/lib/audit";
import { jsonError, jsonOk, unauthorized } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/ratelimit";

/** Trigger an immediate state snapshot upload (session required). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  // Uploading a snapshot is cheap but hits the Telegram API — throttle it.
  const rl = rateLimit(`backup:${clientIp(req)}`, 10, 5 * 60_000);
  if (!rl.allowed) return jsonError(`Too many backups, retry in ${rl.retryAfterSec}s`, 429);

  const res = await flushStateBackup();
  if (!res.ok) return jsonError(res.error ?? "Backup failed", 502);
  audit("backup.flush", user.id, "pinned", `${res.bytes ?? 0} bytes${res.checkpointTaken ? ", checkpoint taken" : ""}`);
  return jsonOk({ ok: true, bytes: res.bytes, checkpointTaken: res.checkpointTaken ?? false, lastBackupAt: backupStatus().lastBackupAt });
}
