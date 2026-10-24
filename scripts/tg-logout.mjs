// One-time migration step before using the bundled Local Bot API server:
// log the bot out of the HOSTED Bot API (api.telegram.org). Telegram refuses
// Local Bot API connections until this is done, and it cannot be undone
// (file_ids issued by the hosted API stop working — re-upload old files).
//
// Usage:  npm run tg:logout     (reads TELEGRAM_BOT_TOKEN from .env or env)
import { readFileSync } from "node:fs";

function envFromFile(key) {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const line = text.split("\n").find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return undefined;
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN || envFromFile("TELEGRAM_BOT_TOKEN");
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set (add it to .env first).");
  process.exit(1);
}

try {
  const res = await fetch(`https://api.telegram.org/bot${token}/logOut`, { method: "POST" });
  const json = await res.json().catch(() => null);
  if (json?.ok) {
    console.log("OK: bot logged out of the hosted Bot API.");
    console.log("You can now run `docker compose up -d` to start Pufflet with the Local Bot API server.");
  } else if (String(json?.description ?? "").toLowerCase().includes("logged out")) {
    console.log("Bot is already logged out of the hosted API — nothing to do.");
  } else {
    console.error(`logOut failed: ${json?.description ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Network error calling logOut: ${err}`);
  process.exit(1);
}
