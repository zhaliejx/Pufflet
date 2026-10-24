// Shared helpers for route handlers: uniform JSON errors that never leak
// stack traces, DB errors, or Telegram payloads.
import { NextResponse } from "next/server";
import { TelegramError } from "@/lib/telegram";

export function jsonOk(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data as Record<string, unknown>, init);
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { message, ...(extra ?? {}) } }, { status });
}

export function unauthorized(message = "Authentication required") {
  return jsonError(message, 401);
}

export function forbidden(message = "Insufficient permissions") {
  return jsonError(message, 403);
}

export function notFound(message = "Not found") {
  return jsonError(message, 404);
}

/**
 * Map a thrown error to a safe response. Internal details are logged
 * server-side only, never returned to clients.
 */
export function errorResponse(err: unknown, fallbackMessage = "Something went wrong"): NextResponse {
  if (err instanceof TelegramError) {
    const status = err.code === "TG_NOT_CONFIGURED" ? 503 : err.code === "TG_TOO_LARGE" ? 413 : 502;
    console.error("[telegram]", err.code, err.message);
    return jsonError(err.message, status, { code: err.code });
  }
  if (err instanceof Error) {
    if (err.message === "PAYLOAD_TOO_LARGE") {
      return jsonError("File exceeds the configured upload limit", 413, { code: "PAYLOAD_TOO_LARGE" });
    }
    console.error("[api]", err.message, err.stack);
  } else {
    console.error("[api]", String(err));
  }
  return jsonError(fallbackMessage, 500);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Content-Disposition value with header-injection-proof filename. */
export function contentDisposition(kind: "attachment" | "inline", filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
