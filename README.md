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

- **Telegram stores the bytes.** Every upload is streamed through the server into a
  private channel via `sendDocument`; Pufflet records the chat id, message id,
  bot-scoped `file_id`, and `file_unique_id` in the database.
- **The database stores the truth about your files** (names, sizes, folder tree,
  trash state, checksums, Telegram references). Backing up the DB backs up your
  *index* — the file contents live in your Telegram channel.
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
     `TELEGRAM_API_HASH` (from my.telegram.org) and **don't** set
     `TELEGRAM_API_BASE` — the entrypoint spawns the Local Bot API on :8081
     and raises both limits to 2000 MB. Requires the one-time `npm run
     tg:logout` migration (see Option B, step 2).
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
