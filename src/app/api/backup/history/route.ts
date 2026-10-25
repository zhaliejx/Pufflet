import { getSessionUser } from "@/lib/auth";
import { backupHistory } from "@/lib/state-backup";
import { errorResponse, jsonOk, unauthorized } from "@/lib/api-utils";

/**
 * Backup inventory for Settings -> Data safety: the pinned hot snapshot
 * (probed in the storage chat) and the recorded cold checkpoints.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  try {
    const history = await backupHistory();
    return jsonOk(history);
  } catch (err) {
    return errorResponse(err, "Could not read backup history");
  }
}
