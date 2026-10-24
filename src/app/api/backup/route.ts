import { getSessionUser } from "@/lib/auth";
import { backupStatus } from "@/lib/state-backup";
import { jsonOk, unauthorized } from "@/lib/api-utils";

/** Snapshot status for the Settings -> Data safety card (session required). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  return jsonOk(backupStatus());
}
