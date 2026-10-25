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

  // State backup ---------------------------------------------------------------
  // Snapshots the metadata index (users, folders, files, API keys) into a
  // pinned document inside the storage chat. On a fresh container Pufflet
  // finds that pinned snapshot and restores it automatically — this is what
  // makes free ephemeral hosts (Hugging Face Spaces, Render, Koyeb, ...)
  // usable without a VPS. Disable with STATE_BACKUP="false".
  stateBackupEnabled: process.env.STATE_BACKUP !== "false",
  stateBackupIntervalMs: intEnv("STATE_BACKUP_INTERVAL_MS", 60_000),

  // Vault (at-rest encryption for files in the storage chat) ------------------
  // Every uploaded file is wrapped in an AES-256-GCM container BEFORE it is
  // sent to Telegram, under an opaque name, and decrypted transparently on
  // download. Disable new-file encryption with PUFFLET_ENCRYPTION="false"
  // (existing vault containers still decrypt regardless of this flag).
  // Key custody:
  //   - PUFFLET_ENCRYPTION_KEY set  -> key derived from that passphrase and
  //     NEVER stored in the DB or the snapshot (you are responsible for
  //     keeping it; losing it makes every vault file undecryptable).
  //   - unset (default)             -> a random 256-bit key is generated on
  //     first upload and kept in the Setting table; it rides inside the
  //     state-backup snapshot so self-heal restores stay decryptable.
  encryptionEnabled: process.env.PUFFLET_ENCRYPTION !== "false",
  encryptionPassphrase: process.env.PUFFLET_ENCRYPTION_KEY ?? "",

  // API tokens ---------------------------------------------------------------
  apiKeyPrefix: "tc_live_",

  // Uploads ------------------------------------------------------------------
  maxFilenameLength: 180,
  maxFolderDepth: 20,
} as const;

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = config.maxDownloadMb * 1024 * 1024;

/** True when TELEGRAM_API_BASE points anywhere other than the hosted Bot API
 *  (i.e. a self-hosted / docker-compose "Local Bot API" server). */
export const USING_LOCAL_BOT_API = config.telegramApiBase !== "https://api.telegram.org";

export function isTelegramConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}
