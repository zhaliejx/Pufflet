// Shared error mapping for rclone routes: ServiceError keeps its status/code,
// RcloneError and TelegramError map to stable HTTP codes, everything else is a
// logged 500 that never leaks internals.
import { NextResponse } from "next/server";
import { ServiceError } from "@/lib/files";
import { RcloneError } from "@/lib/rclone-exec";
import { TelegramError } from "@/lib/telegram";
import { jsonError } from "@/lib/api-utils";

export function rcloneErrorResponse(err: unknown, fallback = "The rclone operation failed"): NextResponse {
  if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
  if (err instanceof RcloneError) {
    const status = err.op.code === "REMOTE_NOT_FOUND" ? 404 : err.op.code === "RCLONE_MISSING" ? 503 : 502;
    return jsonError(err.message, status, { code: err.op.code });
  }
  if (err instanceof TelegramError) {
    // Telegram-side failures surface while reading the source file (send/sync
    // push); same status mapping as the download routes.
    const status = err.code === "TG_NOT_CONFIGURED" ? 503 : err.code === "TG_TOO_LARGE" ? 413 : 502;
    console.error("[telegram]", err.code, err.message);
    return jsonError(err.message, status, { code: err.code });
  }
  console.error("[rclone]", err instanceof Error ? err.message : err);
  return jsonError(fallback, 500);
}
