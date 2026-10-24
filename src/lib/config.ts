// Central configuration — all secrets come from environment variables.
// Never hardcode credentials here. See .env.example for placeholders.

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  appName: "Pufflet",

  // Telegram storage adapter -------------------------------------------------
  // Bot token + storage chat id are SERVER-ONLY secrets.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  // Point this at a self-hosted "Local Bot API" server to lift the hosted
  // Bot API transfer limits (see README). Must include no trailing slash.
  telegramApiBase: (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, ""),

  // Hosted Bot API limits (verified against official docs, see README):
  //  - bot -> Telegram upload (sendDocument): 50 MB
  //  - Telegram -> bot download (getFile):    20 MB
  // Local Bot API server: 2000 MB both ways.
  maxUploadMb: intEnv("MAX_UPLOAD_MB", 50),
  maxDownloadMb: intEnv("MAX_DOWNLOAD_MB", 20),
  telegramRequestTimeoutMs: intEnv("TELEGRAM_TIMEOUT_MS", 120_000),

  // Auth / sessions ----------------------------------------------------------
  sessionTtlDays: intEnv("SESSION_TTL_DAYS", 30),
  sessionCookie: "pufflet_session",

  // API tokens ---------------------------------------------------------------
  apiKeyPrefix: "tc_live_",

  // Uploads ------------------------------------------------------------------
  maxFilenameLength: 180,
  maxFolderDepth: 20,
} as const;

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = config.maxDownloadMb * 1024 * 1024;

export function isTelegramConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}
