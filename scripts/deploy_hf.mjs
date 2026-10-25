#!/usr/bin/env node
// One-command Pufflet deployment to a FREE Hugging Face Space (Docker SDK).
//
//   node scripts/deploy_hf.mjs \
//     HF_TOKEN=hf_xxx \
//     TELEGRAM_BOT_TOKEN=123:ABC \
//     TELEGRAM_API_ID=1234567 \
//     TELEGRAM_API_HASH=abcdef... \
//     [TELEGRAM_CHAT_ID=-100...] \      # optional: auto-discovered from recent updates
//     [HF_SPACE=pufflet] \              # optional Space name (default: pufflet)
//     [--logout]                        # log the bot out of the hosted Bot API
//                                       # (required once before the Space can use it)
//
// What it does, in order:
//   1. verifies the HF token (needs "write" role) and resolves your username
//   2. discovers + validates the storage chat (bot must be an admin there)
//   3. creates the Space (docker sdk) — 409 "exists" is fine
//   4. pushes this project's tracked files into the Space repo,
//      with the HF front matter (sdk: docker, app_port: 7860) prepended to README.md
//   5. sets the four secrets via the Hub API
//   6. (--logout) logs the bot out of the hosted Bot API — IRREVERSIBLE,
//      hosted-issued file_ids stop working; required exactly once
//   7. polls the build until the Space is RUNNING (first build ~5-10 min)
//
// Requirements: bash (git + tar in PATH), Node 18+. Your .env/.db never leave
// the machine: only git-tracked files are pushed (git archive).

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HF = "https://huggingface.co";

// --- args -------------------------------------------------------------------
const args = { flags: new Set() };
for (const a of process.argv.slice(2)) {
  const m = a.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/s);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith("--")) args.flags.add(a);
}
const env = (k) => args[k] ?? process.env[k] ?? "";
const opt = (k, d) => (args[k] ?? process.env[k] ?? d);

const HF_TOKEN = env("HF_TOKEN");
const SPACE_NAME = opt("HF_SPACE", "pufflet").replace(/^\/+|\/+$/g, "").split("/").pop();
const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const API_ID = env("TELEGRAM_API_ID");
const API_HASH = env("TELEGRAM_API_HASH");
let CHAT_ID = env("TELEGRAM_CHAT_ID");
const PROJECT = opt("PROJECT", process.cwd());
const DO_LOGOUT = args.flags.has("--logout");
const FORCE = args.flags.has("--force");

const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-3)}` : "—");
function die(code, msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}
async function hf(path, init = {}) {
  const res = await fetch(`${HF}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${HF_TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}
async function tg(method, params = "") {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}${params}`);
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

// --- 0. usage ----------------------------------------------------------------
if (!HF_TOKEN || !BOT_TOKEN || !API_ID || !API_HASH) {
  console.log(`Usage:
  node scripts/${process.argv[1]?.split("/").pop() ?? "deploy_hf.mjs"} \\
    HF_TOKEN=hf_xxx TELEGRAM_BOT_TOKEN=123:ABC \\
    TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=abcdef \\
    [TELEGRAM_CHAT_ID=-100...] [HF_SPACE=pufflet] [--logout]

Get an HF write token:  huggingface.co -> Settings -> Access Tokens -> New token (Write)
Get api_id/api_hash:    my.telegram.org -> API development tools
Flags:
  --logout  one-time: log the bot out of the HOSTED Bot API (irreversible;
            needed before the Space's Local Bot API server can claim it)
  --force   deploy even if the storage chat check fails`);
  process.exit(1);
}
console.log(`Pufflet -> Hugging Face Space deploy
  token: ${mask(HF_TOKEN)}  bot: …${mask(BOT_TOKEN)}  space: ${SPACE_NAME}`);

// --- 1. whoami ---------------------------------------------------------------
const me = await hf("/api/whoami-v2");
if (!me.ok) die(1, `HF token rejected (HTTP ${me.status}). Needs a WRITE token — get one at huggingface.co/settings/tokens.`);
const USER = me.json.name;
const auth = me.json?.auth?.accessToken?.role ?? me.json?.auth?.token?.role ?? "unknown";
console.log(`✓ signed in as ${USER} (token role: ${auth})`);
if (auth !== "write") die(1, `Token role is "${auth}" — create a WRITE token (fine-grained: allow Space write).`);

// --- 2. storage chat ---------------------------------------------------------
const meTg = await tg("getMe");
if (!meTg.ok) die(2, `Telegram token invalid: ${meTg.description}`);
const botId = meTg.result.id;
console.log(`✓ bot @${meTg.result.username} (${botId})`);

const hosted = await tg("getMe");
const onHosted = hosted.ok === true;
console.log(onHosted
  ? "• bot is currently logged in to the HOSTED Bot API (logOut needed once — pass --logout)"
  : "• bot is free of the hosted API (good — the Space's Local Bot API server can claim it)");

let discovered = [];
if (!CHAT_ID) {
  const ups = await tg("getUpdates?limit=100");
  if (ups.ok) {
    for (const u of ups.result ?? []) {
      for (const key of ["channel_post", "message", "edited_channel_post", "my_chat_member"]) {
        const chat = u[key]?.chat;
        if (chat?.id) discovered.push({ id: String(chat.id), title: chat.title ?? chat.first_name ?? chat.id, type: chat.type });
      }
    }
  }
  if (discovered.length) {
    const pick = discovered.find((c) => c.id.startsWith("-100")) ?? discovered[0];
    CHAT_ID = pick.id;
    console.log(`✓ discovered storage chat candidate: ${CHAT_ID} (${pick.title}, ${pick.type})`);
  }
}
if (!CHAT_ID) {
  console.log(`
✗ No storage chat found (getUpdates is empty).

  1. In Telegram: create a PRIVATE channel (e.g. "Pufflet Storage")
  2. Add @${meTg.result.username} as administrator with POST MESSAGES + DELETE MESSAGES + PIN MESSAGES
  3. Post ANY message in that channel
  4. Re-run this command (it will discover the chat id automatically)
     …or pass TELEGRAM_CHAT_ID=-100xxxxxxxxxx explicitly`);
  process.exit(2);
}
if (onHosted) {
  const chatInfo = await tg("getChat", `?chat_id=${encodeURIComponent(CHAT_ID)}`);
  if (!chatInfo.ok) die(2, `getChat(${CHAT_ID}) failed: ${chatInfo.description} — is the bot an admin there?`);
  const member = await tg("getChatMember", `?chat_id=${encodeURIComponent(CHAT_ID)}&user_id=${botId}`);
  const st = member.result?.status;
  const canPost = member.result?.can_post_messages;
  if ((st !== "administrator" || !canPost) && !FORCE)
    die(3, `Bot is "${st}" in that chat (can post: ${Boolean(canPost)}). Make it an ADMIN with post+delete+pin rights, or pass --force.`);
  console.log(`✓ storage chat ${CHAT_ID} validated (bot status: ${st})`);
}

// --- 3. create the Space -----------------------------------------------------
const repoId = `${USER}/${SPACE_NAME}`;
const created = await hf("/api/repos/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "space", name: SPACE_NAME, sdk: "docker", private: false }),
});
if (created.ok || created.status === 409) {
  console.log(created.ok ? `✓ Space created: ${repoId}` : `• Space ${repoId} already exists — updating it`);
} else {
  die(4, `Space creation failed (HTTP ${created.status}): ${created.text.slice(0, 300)}`);
}

// --- 4. push the code --------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "pufflet-hf-"));
try {
  execSync(`git clone "https://${USER}:${HF_TOKEN}@huggingface.co/spaces/${repoId}" "${tmp}/space" 2>&1 || true`, { shell: "/bin/bash", stdio: "pipe" });
  const spaceDir = `${tmp}/space`;
  if (!existsSync(spaceDir)) die(4, "git clone of the Space failed (network? git installed?)");
  execSync(`git -C "${PROJECT}" archive HEAD | tar -x -C "${spaceDir}"`, { shell: "/bin/bash", stdio: "pipe" });

  const body = readFileSync(join(PROJECT, "README.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  const frontMatter = `---
title: Pufflet
emoji: ☁️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---
`;
  writeFileSync(join(spaceDir, "README.md"), frontMatter + body);
  // Space repos must not carry the project's own git history or sub-repos
  rmSync(join(spaceDir, ".gitattributes"), { force: true });

  execSync(`git -C "${spaceDir}" add -A && git -C "${spaceDir}" -c user.name="Pufflet Deploy" -c user.email="deploy@pufflet.local" commit -m "Deploy Pufflet" -q && git -C "${spaceDir}" push -u origin main -q`, { shell: "/bin/bash", stdio: "pipe" });
  console.log(`✓ code pushed to ${repoId}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- 5. secrets --------------------------------------------------------------
const secrets = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHAT_ID,
  TELEGRAM_API_ID: API_ID,
  TELEGRAM_API_HASH: API_HASH,
};
for (const [k, v] of Object.entries(secrets)) {
  const r = await hf(`/api/spaces/${repoId}/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: k, value: String(v) }),
  });
  if (!r.ok) die(5, `Secret ${k} failed (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`✓ secret ${k} set (${mask(v)})`);
}

// --- 6. optional hosted logOut ------------------------------------------------
if (DO_LOGOUT) {
  if (!onHosted) console.log("• --logout skipped: bot is not on the hosted API");
  else {
    const lo = await tg("logOut");
    if (lo.ok) console.log("✓ bot logged out of the HOSTED Bot API (one-time migration done)");
    else if (String(lo.description ?? "").toLowerCase().includes("logged out"))
      console.log("• bot was already logged out of the hosted API");
    else die(6, `logOut failed: ${lo.description}`);
  }
}

// --- 7. poll the build --------------------------------------------------------
console.log(`\nBuilding ${HF}/spaces/${repoId} — first build takes ~5-10 minutes…`);
const stages = {
  BUILDING: "🔨 building",
  RUNNING: "✅ RUNNING",
  RUNNING_APP_FAILED: "💥 app failed (check the Space's logs)",
  BUILD_ERROR: "💥 build error (check the Space's logs)",
  PAUSED: "⏸ paused",
};
const deadline = Date.now() + 15 * 60_000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  const s = await hf(`/api/spaces/${repoId}`);
  const stage = s.json?.runtime?.stage ?? "?";
  if (stage !== last) { console.log(`  ${stages[stage] ?? stage}`); last = stage; }
  if (stage === "RUNNING") {
    console.log(`
🎉 Pufflet is live: ${HF}/spaces/${repoId}

  1. Open the Space -> sign in:  pufflet@pufflet.com / pufflet   (temporary!)
  2. Settings -> Account -> change the password
  3. Settings -> Telegram storage should show Connected, mode local (2000 MB)
  4. Upload something, then Settings -> Data safety -> "Back up now"
     (free Spaces wipe their disk on restart; that snapshot restores everything)
  5. Your old Render service is no longer needed — suspend or delete it.`);
    process.exit(0);
  }
  if (stage === "BUILD_ERROR" || stage === "RUNNING_APP_FAILED")
    die(7, `Deployment failed at stage ${stage}. Open ${HF}/spaces/${repoId} -> Logs for details.`);
}
console.log(`\nStill building after 15 min — watch ${HF}/spaces/${repoId} (Factory rebuild also helps).`);
