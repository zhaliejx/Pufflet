// Structured, secret-free audit logging.
import { db } from "@/lib/db";

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

/** Fire-and-forget audit event; never throws into the request path. */
export function audit(action: AuditAction, userId: string | null, target?: string, detail?: string): void {
  db.auditEvent
    .create({
      data: { userId: userId ?? undefined, action, target: target ?? undefined, detail: detail?.slice(0, 500) },
    })
    .catch(() => {});
}
