# Pufflet ☁️

**A personal cloud storage web app with a friendly face.** Pufflet gives you a polished,
Google-Drive-style file manager backed by a Telegram channel as the storage layer:
upload, browse, organize, search, download, trash, restore, and delete files — without
ever opening Telegram. A versioned REST API with scoped API tokens lets your own
scripts and apps use the same storage.

![Pufflet](public/logo.svg)

## How it works

```
Browser ──HTTPS──> Pufflet (Next.js) ──Bot API──> your private Telegram channel
                       │
                       ▼
                 metadata DB (Prisma: files, folders, users, API keys, audit)
```

- **Telegram stores the bytes — encrypted.** Every upload is wrapped in an
  AES-256-GCM vault container (with random padding and an opaque filename)
  before it is streamed through the server into a private channel via
  `sendDocument`; Pufflet records the chat id, message id, bot-scoped
  `file_id`, and `file_unique_id` in the database. The channel holds
  ciphertext only — no names, no extensions, no recognizable headers.
- **The database stores the truth about your files** (names, sizes, folder tree,
  trash state, checksums, Telegram references). Backing up the DB backs up your
  *index* — the file contents live in your Telegram channel. On download the
  vault container is detected and decrypted transparently; files uploaded
  before the vault existed stream through untouched.
- **Secrets stay server-side.** The bot token is never sent to the browser;
  downloads stream through an authenticated route instead of exposing Telegram URLs.

## Features

- 🔐 Zero-setup first run: Pufflet seeds a default owner account
  (`pufflet@pufflet.com` / temporary password `pufflet`) and nags you to change
  it — Settings → Account — until you do; disable seeding with
  `SEED_DEFAULT_USER="false"` to get the classic first-run setup screen instead
- 🔑 Password change from the UI (signs out all other devices), scrypt-hashed
  passwords, DB-backed httpOnly cookie sessions, login rate limiting
- 📁 Nested folders with breadcrumbs, rename/move, **circular-nesting protection**
- 📤 Streaming uploads (create-job → PUT raw bytes) with real progress, cancel,
  retry-able failure state, duplicate-name de-duplication, SHA-256 checksums
- 🌐 **Import from Google Drive** — paste a Drive share link and the SERVER pulls
  the file straight from Google (Drive → Pufflet → Telegram): the browser never
  downloads it first. Handles the virus-scan interstitial automatically, gives
  actionable errors for private/deleted files, folders, and Docs links (see
  [Import from Google Drive](#import-from-google-drive))
- 🔗 **Public share links** — share any file with a no-login URL (`/s/<token>`),
  with a branded download page, optional inline preview for images/video/PDF,
  download counters, revocation, optional expiry, and per-IP rate limiting
- 🔒 **Vault: encrypted + obfuscated storage** — files are AES-256-GCM encrypted,
  randomly padded, and stored under opaque names (`pf-….bin`) in your channel;
  downloads decrypt transparently with the original filename (legacy files keep
  working untouched)
- 📥 Authenticated streaming downloads with safe `Content-Disposition` headers
- ⭐ Starred, 🕘 Recent, 🗑️ Trash with restore + permanent delete + empty trash
  (trash keeps the Telegram message until permanent deletion)
- 🔍 Filename search, list & grid views, drag-and-drop upload, context menus,
  responsive mobile layout
- 🔑 REST API (`/api/v1`) with scoped API tokens: `read`, `write`, `delete`,
  `admin` — shown once at creation, stored as SHA-256 hashes, revocable, expirable
- 🧾 Audit log, structured logs with secret redaction, health endpoint at `/api/health`
- 🖥️ **Bundled Local Bot API server** — the official
  [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server ships inside
  the Docker image (or as a compose sidecar) and unlocks 2000 MB uploads/downloads
  with zero manual setup
- 🛟 **Self-healing state backup** — the file index is snapshotted into ONE pinned
  Telegram document, refreshed automatically after changes, and auto-restored on
  boot. Free ephemeral hosts (Hugging Face Spaces, Render, Koyeb) therefore survive
  restarts with zero data loss. Monitor it and trigger "Back up now" in
  Settings → Data safety
- ✅ Automated tests: unit tests (crypto, tokens, folder cycles, multipart,
  Telegram adapter with mocked fetch) + end-to-end API suite (runs against a
  local mock Telegram Bot API — no real credentials needed)

## Telegram Bot API constraints (verified)

Pufflet uses the **official Bot API** and does not try to bypass its limits:

| Direction | Hosted Bot API | Self-hosted Local Bot API server |
|---|---|---|
| Upload (`sendDocument`) | **50 MB** per file | **2000 MB** per file |
| Download (`getFile`) | **20 MB** per file | **2000 MB** per file |

Because of the hosted 20 MB `getFile` download limit, hosted deployments enforce
`MAX_UPLOAD_MB=50` / `MAX_DOWNLOAD_MB=20`. If you need larger files, run the
official [Local Bot API server](https://github.com/tdlib/telegram-bot-api) —
bundled in `docker-compose.yml`, embedded in the all-in-one Docker image, **or
as a standalone server on any always-on host** (Render, Fly.io, a VPS — see
*Deploying → Option A*); point `TELEGRAM_API_BASE` at it, and
raise both limits. Pufflet never uses undocumented
behavior; `file_unique_id` is treated as an index key, never a download handle or
content checksum (integrity uses SHA-256 computed while streaming).

**How downloads actually work (verified against the server source + the pinned
binary):** the hosted Bot API serves bytes over HTTP at
`/file/bot<token>/<file_path>` (≤ 20 MB). The **Local Bot API server has no
such HTTP route at all** — it answers `404 Not Found`. In `--local` mode,
`getFile` instead returns the file's **absolute path on disk** (the server
re-downloads the file from Telegram's cloud into its work dir first). Pufflet
therefore reads local-mode downloads straight from the filesystem — which is
why the compose stack mounts the `bot-api-data` volume into the app container
at the same path, and why the all-in-one image works out of the box.

Stale references self-heal: if `getFile` fails for an old file (e.g. the local
server restarted and lost its file database), Pufflet re-sends the document
**by `file_id`** — which re-registers it with the running server and yields a
fresh `file_id` — retries the download transparently, persists the new
Telegram references, and deletes the replaced message so the channel stays
clean.

Other notes:

- `file_id` is bot-specific — rotating to a different bot invalidates download handles.
- Telegram is not object storage: keep the channel private, and remember that
  deleting a message in Telegram deletes the file for good.
- Database transactions cannot cover the Telegram call. The upload flow is ordered
  *Telegram first, DB row last*; failures leave an explicit FAILED job with no
  phantom file. Purges delete the Telegram message **first** and keep the row on
  failure so destructive operations can be retried honestly.

## Quick start

Requirements: **Node.js 20+ (or Bun), a Telegram bot token, a private storage channel.**

```bash
# 1. install
bun install            # or: npm install

# 2. configure
cp .env.example .env   # then fill in the Telegram + database values

# 3. create the database
bun run db:push

# 4. run
bun run dev            # http://localhost:3000

# 5. first visit -> sign in with the seeded default account
#    pufflet@pufflet.com / pufflet  (temporary)
#    then change the password in Settings -> Account
```

> Prefer choosing your own owner credentials on first run? Set
> `SEED_DEFAULT_USER="false"` in `.env` and Pufflet shows the classic setup
> screen instead of seeding the default account.

### Storage-channel setup (5 minutes)

1. Message **@BotFather** → `/newbot` → save the token into `TELEGRAM_BOT_TOKEN`.
2. Create a **private** channel (e.g. "Pufflet Storage") and add your bot as an
   **administrator** with *post messages* + *delete messages* + *pin messages* rights
   (pinning is needed for the state snapshot — see *Deploying → State backup*).
3. Post any message in the channel, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`
   into `TELEGRAM_CHAT_ID` (channels are typically `-100…`).
4. Restart the app — **Settings → Telegram storage** should show *Connected*.

## Testing

```bash
bun test               # unit tests (no network, mocked Telegram)
bun run lint           # eslint
bun run test:e2e       # 30-step API suite; needs dev server + mock Telegram:
cd mini-services/telegram-mock && bun run index.ts   # mock Bot API on :3031
```

The E2E suite covers auth failures, upload/retry/duplicates, download round-trips,
trash/restore/purge, circular folder moves, API-token scopes/expiry/revocation,
input validation, and login rate limiting. A test-mode mock adapter keeps real
Telegram credentials out of automated tests.

## Deploying

**No VPS required.** Option A (Vercel + a self-hosted Bot API server) and
Option B (Hugging Face Spaces) are both free-tier friendly and need nothing
but a browser and your Telegram credentials.

### Option A — Vercel + your own Bot API server (~15 minutes, free tiers)

The strongest free combo: **Pufflet runs on Vercel** (serverless, zero
maintenance) while the **official Local Bot API server runs on any host that
keeps a process alive** — Render's free tier works great. Pufflet needs one
environment variable (`TELEGRAM_API_BASE`) pointing at that server, and the
Bot API's 2000 MB limits apply.

Honest limits of this split:

- **Downloads: up to 2000 MB per file.** They stream through Vercel functions,
  which may run up to 300 s on the Hobby plan (Fluid compute, on by default for
  new projects). A 2 GB file needs a sustained ~7 MB/s to fit that window —
  treat "a few hundred MB" as the comfortable zone on slower links.
- **Uploads: ≈4 MB per file.** Vercel caps a function's *request body* at
  4.5 MB — a platform limit no backend configuration can lift — so keep
  `MAX_UPLOAD_MB=4`. Need 2000 MB uploads too? Option B runs the same app with
  the bot API embedded, fully free, in both directions.
- Bandwidth budgets: Vercel Hobby includes 100 GB fast data transfer + 10 GB
  fast origin transfer per month; Render free includes 100 GB egress per month.
  Plenty for personal use — a cloud of downloaded movies will hit them.

**Step 1 — the Bot API server (skip if you already have one).** On Render:
*New + → Web Service → Existing image* → `aiogram/telegram-bot-api:latest` →
under *Advanced* set the **Docker Command** (substitute your own values from
[my.telegram.org](https://my.telegram.org) → *API development tools*):

```
--api-id=1234567 --api-hash=0123456789abcdef0123456789abcdef --local --http-port=8081
```

Render detects the listening port and routes
`https://<your-service>.onrender.com` to it. ⚠️ **`--local` is mandatory** —
it is what lifts the limits and what makes `getFile` return a servable file
path. Any Docker host works the same way (same image + command, or the
`bot-api` service in `docker-compose.yml`).

**Step 2 — one-time `logOut` migration.** If your bot has ever talked to the
hosted API (any `api.telegram.org` call), Telegram refuses Local Bot API
connections until it logs out. From your machine with `TELEGRAM_BOT_TOKEN` in
`.env`: `npm run tg:logout` — once, irreversible; hosted-issued `file_id`s stop
working (re-upload anything uploaded before the switch).

**Step 3 — the Vercel app.**

1. **Database** — create a free Postgres at [neon.tech](https://neon.tech)
   (or Vercel Postgres) and copy the connection string.
2. **Schema** — push it once from your machine:
   ```bash
   DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" \
     npx prisma db push --schema prisma/schema.postgres.prisma
   ```
3. **Import** — vercel.com → *Add New → Project* → import this GitHub repo.
   The framework auto-detects Next.js; `vercel.json` already sets the correct
   build command (generates the Prisma client from the Postgres schema).
4. **Environment variables** (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Postgres connection string (`?sslmode=require`) |
   | `TELEGRAM_BOT_TOKEN` | your bot token |
   | `TELEGRAM_CHAT_ID` | your storage channel id |
   | `TELEGRAM_API_BASE` | `https://<your-bot-api>.onrender.com` (no trailing slash) |
   | `MAX_UPLOAD_MB` | `4` (Vercel request-body cap) |
   | `MAX_DOWNLOAD_MB` | `2000` (Local Bot API limit) |
   | `STATE_BACKUP` | `false` (Postgres already persists; snapshots add nothing here) |
   | `SEED_DEFAULT_USER` | `true` (default) — seeds `pufflet@pufflet.com` / `pufflet` |

5. **Deploy** → open the URL → sign in with the seeded account
   (`pufflet@pufflet.com` / `pufflet`) → **change the password immediately** in
   Settings → Account (the login screen shows the hint until you do).
6. **Check** — Settings → *Telegram storage* should show *Connected* with
   storage mode **local (2000 MB)**.

Notes:

- **Keep the Render server awake.** Free services spin down after 15 idle
  minutes and then need ~1 minute to wake (Pufflet's 120 s request timeout
  absorbs that, but it feels slow). Point a free pinger such as cron-job.org
  or UptimeRobot at `https://<your-bot-api>.onrender.com/` every 5–10 minutes;
  Render's 750 free instance-hours cover one always-on service.
- **Security.** The Bot API server is a public endpoint that only answers
  requests carrying your bot token — keep the URL low-key and the token in
  Vercel's environment, never in the browser.
- The server's disk is ephemeral and that is fine: `getFile` re-fetches file
  content from Telegram on demand, so no persistent volume is needed.

### Option B — Hugging Face Spaces (FREE, no VPS, 2000 MB both ways)

One free Space (2 vCPU / 16 GB RAM, Docker SDK) runs the **all-in-one image**:
the Next.js app *plus* the official Local Bot API server in the same container.
This is also the free way to get **2000 MB uploads** — the Vercel path above
caps uploads at ≈4 MB.
Free Spaces sleep after ~48 h of inactivity and wipe their disk on every
restart — Pufflet's **state backup** (below) restores everything automatically
within seconds of waking up.

> **Space wizard tip:** pick the **Docker** SDK — not *Static* (a Static Space
> only serves fixed HTML and cannot run Pufflet's server). Then you can skip
> the manual steps and deploy in one command:
>
> ```bash
> node scripts/deploy_hf.mjs \
>   HF_TOKEN=hf_xxx \
>   TELEGRAM_BOT_TOKEN=123:ABC \
>   TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=abcdef \
>   --logout
> ```
>
> The script verifies your HF token, discovers + validates the storage chat,
> creates the Space, pushes the code, sets the secrets, performs the one-time
> hosted `logOut`, and waits for the build — then prints the first-login steps.

1. **Telegram prep** (same as the Quick start): bot token via @BotFather, a
   private storage channel where the bot is admin with post + delete + **pin**
   rights, and `api_id` + `api_hash` from
   [my.telegram.org](https://my.telegram.org) → *API development tools*.
2. **One-time migration** (from your machine, with `TELEGRAM_BOT_TOKEN` in `.env`):
   ```bash
   npm run tg:logout
   ```
   Telegram requires bots to log out of the hosted API before talking to a
   Local Bot API server. ⚠️ Hosted-issued `file_id`s stop working after this —
   do it before uploading anything you care about through local mode.
3. **Create the Space** — huggingface.co → *New Space* → name it → SDK:
   **Docker** → Blank template → clone the Space repo and copy this project's
   files in. Keep/paste this front matter at the very top of the Space's
   `README.md` (it configures the Docker runtime):
   ```yaml
   ---
   title: Pufflet
   emoji: ☁️
   colorFrom: blue
   colorTo: indigo
   sdk: docker
   app_port: 7860
   ---
   ```
4. **Secrets** — Space → *Settings → Variables and secrets* → add
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_API_ID`,
   `TELEGRAM_API_HASH` (as *secrets*). The entrypoint detects the API
   id/hash, starts the embedded Local Bot API server, and raises both limits
   to 2000 MB automatically.
5. **Open your Space** → sign in `pufflet@pufflet.com` / `pufflet` → change the
   password immediately (a free Space URL is public; your login is the gate).
6. Upload something, then Settings → Data safety → **Back up now** to pin the
   first snapshot (after that, flushing is automatic).

Notes:

- Restarted/slept Spaces auto-restore from the pinned snapshot — never delete
  or unpin the `pufflet-state-backup.json` message in your storage chat.
- First build takes ~5–10 minutes; later restarts are seconds.
- Prefer a different free host? Render (below) and Koyeb run the same image;
  everything behaves identically.

### Option B2 — Render (free tier, same all-in-one image)

Render runs this repo's `Dockerfile` directly (runtime: **Docker**, detected
automatically) — that's the same all-in-one image as Option B: app + optional
embedded Local Bot API in one container. Free instances sleep after ~15 min
idle and have an ephemeral disk; the **state backup** (below) restores the
index on every wake-up.

1. **New Web Service** → connect your fork/copy of this repo. Runtime
   **Docker** is auto-detected from the `Dockerfile`; leave build/start
   commands empty. Port detection is automatic (the image listens on `$PORT`,
   default 7860). Optionally set the health check path to `/api/health`.
2. **Environment** (Dashboard → *Environment*):
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — always required.
   - Already running your own Bot API server somewhere (e.g. another Render
     service)? Add `TELEGRAM_API_BASE=https://your-bot-api.onrender.com` and
     set `MAX_UPLOAD_MB` / `MAX_DOWNLOAD_MB` to what that server really
     allows. Do **not** set `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` in this
     mode — the embedded server stays off.
   - Want the embedded 2000 MB mode instead? Add `TELEGRAM_API_ID` +
     `TELEGRAM_API_HASH` and **don't** set `TELEGRAM_API_BASE` — the
     entrypoint spawns the Local Bot API on :8081 and raises both limits to
     2000 MB. Where the values come from: log in at
     <https://my.telegram.org> → *API development tools* (with your **phone
     number**, not the bot) → `api_id` is a small number like `1234567` and
     `api_hash` is a 32-character hex string. **The number at the start of
     your bot token is NOT the api_id** — it's the bot id, and the Bot API
     server refuses to start on it (the entrypoint catches this and says so).
     Values must be pasted plain: no quotes, no spaces.
   - Embedded mode also needs the **one-time hosted logOut** before the bot
     can log in to your local server: open
     `https://api.telegram.org/bot<TOKEN>/logOut` in a browser (expect
     `{"ok":true,"result":true}`) or run `npm run tg:logout` locally (see
     Option B, step 2). Do this *before/while* deploying — it can take up to
     10 minutes to take effect, and until then Telegram calls fail with a
     conflict/unauthorized error.
   - `DATABASE_URL` — leave unset (SQLite at `/app/db/pufflet.db`).
3. **Deploy** → first build ~5–10 min → open the URL → sign in
   `pufflet@pufflet.com` / `pufflet` → change the password in Settings.

Notes:

- On the free tier (ephemeral disk) the embedded Local Bot API keeps its file
  cache in the container, so files uploaded through it stop downloading after
  a restart/sleep — the index restores, but re-upload the bytes. Pointing at
  an external Bot API server with a persistent disk avoids this; hosted
  Telegram (`TELEGRAM_API_BASE` unset, no api id/hash) never loses files.
- Paid instances can attach a **Disk** mounted at `/app/db` to persist the
  SQLite database across deploys.

#### External database on Render — stop the per-redeploy resets (recommended)

Render's free disk is wiped on every deploy/sleep, which resets the SQLite
index: your password, folder structure and share links vanish and files in the
channel become unindexed. Point Pufflet at an **external PostgreSQL** and the
whole index becomes durable — redeploys just reconnect to it.

1. **Create the database** — Render Dashboard → *New* → *PostgreSQL* (pick the
   **same region** as the web service; the internal connection string is
   faster and free of egress). Any managed Postgres works too: Neon,
   Supabase, Railway, a VPS `postgres` — the image auto-detects it.
2. **Wire it up** — in the web service's *Environment*, add:

   ```
   DATABASE_URL = <your Postgres connection string>
   ```

   - Same-region Render database: use the **Internal Database URL**
     (`postgres://user:pass@dpg-xxx/dbname`) — no extra params needed.
   - Anything reached over the public internet (Render **External Database
     URL**, Neon, Supabase, ...): append `?sslmode=require` — most providers
     hand you the string pre-built; keep it.
   - Leave `DATABASE_URL` unset to stay on SQLite (file-based, inside the
     container).

3. **Deploy.** On boot the entrypoint sees the `postgres://` scheme,
   regenerates the Prisma client for PostgreSQL, and pushes the schema
   (retries for ~1 min while a freshly created database is still
   provisioning; `GET /api/health` shows `databaseProvider` afterwards).
   Then it seeds the default account — or, better:

4. **Data on first boot.** If a pinned state snapshot already exists in your
   storage chat (Settings → Data safety shows when the last one was taken),
   the empty external DB is auto-restored from it — users, password, files,
   API keys and share links all come back and Telegram messages keep working.
   Note the index rows that only ever lived in the wiped SQLite file are
   gone for good — those channel messages were already orphaned by previous
   redeploys.

Two ways to run it from here:

- **STATE_BACKUP stays on (default, recommended).** The pinned snapshot in
  your storage chat becomes a rolling off-site backup of the index: even a
  lost/deleted database can be re-created from it on the next boot.
- **`STATE_BACKUP="false"`** to rely on the external DB alone (fewer
  Telegram calls; how the Vercel guide runs).

File **bytes** always live in your Telegram storage chat either way — the
database is only the index.

### Option C — Any Docker host (VPS, home server, Railway)

```bash
# compose stack: app + Local Bot API sidecar (2000 MB), port 3000
cp .env.example .env   # fill in TOKEN, CHAT_ID, API_ID, API_HASH
npm run tg:logout      # one-time hosted->local migration (see caveats above)
docker compose up -d

# or the single all-in-one container (embedded bot-api, port 7860)
docker build -t pufflet .
docker run -p 3000:7860 --env-file .env pufflet
```

Notes:

- The app container runs `prisma db push` on boot and stores its SQLite DB in
  the `pufflet-db` volume; the bot-api session/data lives in `bot-api-data`.
- **Migration caveat:** after `logOut`, `file_id`s issued by the hosted API stop
  working. Files uploaded *before* switching to the Local Bot API must be
  re-uploaded (their Telegram messages remain intact).
- To go back to hosted mode: remove `TELEGRAM_API_BASE`/`TELEGRAM_API_ID`/
  `TELEGRAM_API_HASH` overrides and re-deploy — the bot keeps working hosted
  (new uploads get new hosted `file_id`s).

### State backup (how the self-healing works)

Pufflet's *index* (users, folders, file records, API keys) lives in a local
database; the file bytes live in your Telegram channel. On hosts without a
persistent disk, the database would vanish on every restart — so Pufflet keeps
a **JSON snapshot of the index pinned as a document inside your own storage
chat**:

- After any change (upload, rename, move, trash, key create, password change…)
  the snapshot is re-uploaded — always into the **same message** via
  `editMessageMedia`, so it never spams the chat.
- On boot, if the database is empty (fresh container), Pufflet reads
  `getChat` → `pinned_message`, downloads the snapshot and restores the index
  in one transaction. Telegram messages themselves are never touched, so every
  file keeps working.
- Sessions/audit/upload-jobs are intentionally not snapshotted (transient).
- The snapshot contains password and API-key hashes — one more reason the
  storage chat must stay private.
- Disable with `STATE_BACKUP="false"` (recommended on Vercel, where a hosted
  Postgres already persists). Interval is `STATE_BACKUP_INTERVAL_MS`
  (default 60 s). Status + manual "Back up now": Settings → Data safety.

### Vault — at-rest encryption & obfuscation

Everything Pufflet sends to your storage chat is ciphertext: before a single
byte leaves the server, the file is wrapped in a **`PUFFENC1` container** —
`magic ‖ version ‖ 12-byte nonce ‖ padded AES-256-GCM payload ‖ 16-byte tag`,
with the whole header acting as GCM associated data (tamper → decrypt fails).
Obfuscation rides on top:

- **Opaque names** — uploads are stored as `pf-<24 hex>.bin`; the real filename
  and extension never reach Telegram, they live only in the metadata DB.
- **Generic content type** — Telegram always sees `application/octet-stream`.
- **Random padding** — 0–64 KiB of encrypted size noise, so message sizes don't
  reveal the exact size distribution of your files.

Downloads (`/api/files/{id}/download` and `/api/v1/files/{id}/download`) detect
the magic and decrypt transparently, serving the original bytes under the
original name. Files uploaded before the vault existed (no magic) pass through
untouched — no migration needed.

**Key custody** (choose one):

| Mode | How | Trade-off |
|------|-----|-----------|
| Passphrase (recommended) | set `PUFFLET_ENCRYPTION_KEY` → key derived via scrypt, never stored | Key exists only on the server env; lose the passphrase and vault files are gone |
| Auto (default) | unset → a random 256-bit key is generated on first upload and kept in the `Setting` table | Zero setup; the key rides inside the state-backup snapshot, so self-heal restores stay decryptable (the snapshot must stay private) |

Notes:

- This is **server-side at-rest encryption, not end-to-end**: the Pufflet
  process holds the key precisely so it can decrypt downloads for you. Anyone
  who controls the server (or reads both the DB and the chat) can decrypt.
  For hostile-host scenarios, encrypt archives client-side before uploading.
- Turn new-file encryption off with `PUFFLET_ENCRYPTION="false"` — existing
  vault containers still decrypt regardless of the flag.
- Changing `PUFFLET_ENCRYPTION_KEY` (or wiping the `Setting` row in auto mode)
  makes previously encrypted files undecryptable. The SHA-256 checksums are
  computed on plaintext, so you can always verify a download's integrity.

### Share links — public downloads without an account

Right-click any file (or open the ⋮ menu) → **Share** to create a public link:

- The URL is a pure capability token: `/s/<43-char base64url>` — 32 random
  bytes, unguessable, shown once to you and copied to your clipboard. Anyone
  with the URL can download that one file **without logging in**; nothing else
  on your drive is reachable through it.
- Recipients get a branded download page with name, size and (for images,
  videos and PDFs) an inline preview. Other types download as attachments.
- Links can be **revoked** anytime in the same dialog, can carry an optional
  expiry (`expiresInDays` via the API), and show a download counter.
- Public downloads are rate-limited per IP (30/min), audited, counted on the
  link row, and stream through the same vault-decoding pipeline as logged-in
  downloads — recipients always get the original bytes.
- Share links ride inside the state-backup snapshot (v3), so handed-out URLs
  keep working after a self-heal on an ephemeral host.

API (see `docs/API.md`): `POST/GET/DELETE /api/v1/files/{id}/share`, plus the
public `GET /api/share/{token}` (metadata) and
`GET /api/share/{token}/download` (bytes).

### Import from Google Drive

**Upload ▾ → From Google Drive…** lets you import a file by pasting its Drive
share link. The transfer is server-to-server (Drive → Pufflet → Telegram), so
your phone or laptop never downloads the file first — a 200 MB video costs you
no mobile data at all.

How it works and what to know:

- The link must be a **regular file** shared as **“Anyone with the link”**
  (right-click the file in Google Drive → Share → Copy link). Private links get
  an inline error telling you exactly that; folders, Google Docs/Sheets/Slides
  links and non-Drive URLs are rejected up front with guidance.
- The server follows Google's “can't scan this file for viruses” interstitial
  automatically (no OAuth, no Google API project, no extra setup), streams the
  bytes through the same vault-encryption pipeline as device uploads, and the
  new file appears in the uploads dock and listing like any other upload.
- The normal upload limit applies (`MAX_UPLOAD_MB`, default 50 MB on the hosted
  Bot API — 2000 MB with the bundled Local Bot API server). Oversized Drive
  files are rejected with their real size before any bytes are pulled.
- Imports are tracked as upload jobs, so failures are visible and retryable,
  cancel works mid-download, and jobs that die with the server are swept into
  FAILED after 30 minutes instead of hanging forever.
- **Why not the “My Drive” entry in the phone's file picker?** Android's storage
  manager can offer cloud files through the system picker, but many browsers
  hand the web app an EMPTY file (0 bytes) because the content lives in the
  cloud, not on the device. Pufflet now detects that case and points you to
  this import flow — which is exactly what the picker was trying to do, minus
  the phone in the middle.
- `POST /api/uploads/remote { url, folderId?, probe? }` (web session auth) is
  the backing endpoint: `probe: true` resolves name/size without downloading.
- Tests: `PUFFLET_GDRIVE_BASE` can point the downloader at a local fake (the
  telegram-mock service implements one), which is how the end-to-end suite
  validates imports — including the scan-warning flow — without internet.

### Any host (bare Node/Bun)

- Build with `npm run build && npm run start` (or run `bun run dev` behind a
  reverse proxy for personal use). Set `NODE_ENV=production` so session cookies
  are `Secure`.
- **Backups:** the state snapshot covers the index automatically; for extra
  safety schedule `pg_dump`/file-copy of the metadata DB as well.
- **Reconciliation:** if a Telegram delete succeeds but the process dies before
  the DB update, the file row will fail on the next purge attempt with the exact
  Telegram error — delete it again once fixed. Failed upload jobs are visible in
  the stats endpoint and can be cleaned by re-PUT or cancel.
- All configuration is environment-based; see `.env.example`. Never commit `.env`.

## Security posture

- Authorization enforced on every server request (session **or** scoped API token)
- Parameterized queries via Prisma; filenames sanitized (traversal/control chars)
- Content-Disposition header injection prevented; downloads `no-store` + `nosniff`
- Login rate limiting (failures-only window), API-auth rate limiting
- Passwords: scrypt (N=16384) with per-user salt, constant-time verification
- API tokens: 32 random bytes (256-bit), shown once, SHA-256 hashed at rest,
  scope + expiry + revocation enforced per request, `lastUsedAt` tracking
- Vault: AES-256-GCM containers with AAD-protected headers, 0–64 KiB random
  padding, opaque storage names; plaintext never leaves the server
- Raw tokens, stack traces, Telegram payloads, and DB errors never reach clients

## Repository layout

```
src/app/                    Next.js App Router: page + API routes
src/app/api/v1/             versioned REST API (token auth)
src/app/api/backup/         state snapshot status + manual flush (session auth)
src/components/pufflet/     UI (store, file list, dialogs, settings, logo)
src/lib/                    services: files, telegram adapter, auth, seed, crypto, …
src/lib/state-backup.ts     pinned-document index snapshot/restore engine
src/instrumentation.ts      boot hook: auto-restore + auto-backup timer
prisma/schema.prisma        data model (SQLite default; Postgres variant in schema.postgres.prisma)
Dockerfile                  ALL-IN-ONE image (app + embedded Local Bot API, port 7860)
docker-compose.yml          app + Local Bot API sidecar variant (2000 MB)
scripts/tg-logout.mjs       one-time hosted->local Bot API migration (npm run tg:logout)
scripts/deploy_hf.mjs       one-command deploy to a free Hugging Face Space (Docker SDK)
scripts/gen_logo.py         regenerates the SVG logo from the original design
scripts/e2e_api_test.sh     end-to-end API test suite
mini-services/telegram-mock local mock Bot API for tests/demos
tests/unit/                 unit tests
docs/API.md                 REST API reference
vercel.json                 Vercel build command (postgres prisma client)
```

## Known limitations

- Single-node in-memory rate limiter (fine for personal use; swap for Redis when clustering)
- Full-text *content* search is out of scope (filename + metadata search only)
- The hosted Bot API's 20 MB download cap applies unless you self-host the Local
  Bot API server (bundled, or remote via `TELEGRAM_API_BASE`); on Vercel uploads
  are additionally capped at ≈4 MB by the platform's 4.5 MB request-body limit,
  regardless of which Bot API is used
- Folder trash/restore uses shared timestamps: items trashed individually keep
  their own trash time and are not silently restored with the folder
- The state snapshot assumes the bot has the *pin messages* admin right in the
  storage chat — without it, backups upload but a fresh container cannot find
  them (Settings → Data safety shows a clear warning instead)
