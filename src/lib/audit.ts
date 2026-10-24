// Structured, secret-free audit logging.
import { db } from "@/lib/db";
import { markStateDirty } from "@/lib/state-backup";

export type AuditAction =
  | "auth.setup"
  | "auth.login"
  | "auth.logout"
  | "auth.login_failed"
  | "auth.password_change"
  | "file.upload"
  | "file.upload_failed"
  | "file.rename"
  | "file.move"
  | "file.star"
  | "file.download"
  | "file.trash"
  | "file.restore"
  | "file.purge"
  | "folder.create"
  | "folder.rename"
  | "folder.move"
  | "folder.trash"
  | "folder.restore"
  | "folder.purge"
  | "key.create"
  | "key.revoke";

// Actions that change data covered by the state snapshot (users, folders,
// files, API keys). Sessions/audit rows are transient and not snapshotted.
const STATE_TRACKED = new Set<AuditAction>([
  "auth.setup",
  "auth.password_change",
  "file.upload",
  "file.rename",
  "file.move",
  "file.star",
  "file.trash",
  "file.restore",
  "file.purge",
  "folder.create",
  "folder.rename",
  "folder.move",
  "folder.trash",
  "folder.restore",
  "folder.purge",
  "key.create",
  "key.revoke",
]);

/** Fire-and-forget audit event; never throws into the request path. */
export function audit(action: AuditAction, userId: string | null, target?: string, detail?: string): void {
  if (STATE_TRACKED.has(action)) markStateDirty();
  db.auditEvent
    .create({
      data: { userId: userId ?? undefined, action, target: target ?? undefined, detail: detail?.slice(0, 500) },
    })
    .catch(() => {});
}
