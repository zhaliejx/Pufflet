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
- 🖥️ **Bundled Local Bot API server** — `docker compose up -d` starts the official
  [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server as a
  sidecar and points Pufflet at it, unlocking 2000 MB uploads/downloads with
  zero manual setup
- ✅ Automated tests: unit tests (crypto, tokens, folder cycles, multipart,
  Telegram adapter with mocked fetch) + end-to-end API suite (runs against a
  local mock Telegram Bot API — no real credentials needed)

## Telegram Bot API constraints (verified)

Pufflet uses the **official Bot API** and does not try to bypass its limits:

| Direction | Hosted Bot API | Local Bot API server (bundled via Docker) |
|---|---|---|
| Upload (`sendDocument`) | **50 MB** per file | **2000 MB** per file |
| Download (`getFile`) | **20 MB** per file | **2000 MB** per file |

Because of the hosted 20 MB `getFile` download limit, hosted deployments enforce
`MAX_UPLOAD_MB=50` / `MAX_DOWNLOAD_MB=20`. If you need larger files, run the
official [Local Bot API server](https://github.com/tdlib/telegram-bot-api) —
Pufflet ships it ready-to-use in `docker-compose.yml` (see *Deploying →
Docker with the bundled Local Bot API*), point `TELEGRAM_API_BASE` at it, and
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
   **administrator** with *post messages* + *delete messages* rights.
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

### Option A — Docker with the bundled Local Bot API server (recommended)

One command gives you the app **plus** the official Local Bot API server as a
sidecar — uploads and downloads up to **2000 MB per file**, no manual
installation:

```bash
# 1. configure — fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
#    and the two values below from https://my.telegram.org -> API tools
cp .env.example .env
#    TELEGRAM_API_ID=...      TELEGRAM_API_HASH=...

# 2. ONE-TIME: log the bot out of the hosted Bot API (Telegram requires this
#    before it will talk to a Local Bot API server)
npm run tg:logout

# 3. launch the stack (app on :3000 + bot-api sidecar)
docker compose up -d

# 4. sign in -> pufflet@pufflet.com / pufflet -> change it in Settings -> Account
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
- Run it on any VPS/Raspberry Pi/home server with Docker — that is where the
  2000 MB limits actually make sense (uploads flow through the server).

### Option B — Vercel (serverless)

Vercel works, with honest caveats: serverless functions cap the request body at
**~4.5 MB** (so uploads are limited to ≈4 MB per file regardless of
`MAX_UPLOAD_MB`), functions have execution time limits, and there is no
persistent disk — so PostgreSQL (e.g. Vercel Postgres / Neon) replaces SQLite.
For the full 2000 MB experience use Option A.

```bash
# 1. create a Postgres database (Vercel Postgres or Neon) and note the URL

# 2. push the schema to it (once, from your machine):
DATABASE_URL="postgresql://…" npx prisma db push --schema prisma/schema.postgres.prisma

# 3. import the repo on vercel.com (framework auto-detects Next.js).
#    vercel.json already sets the right build command (generates the Prisma
#    client from the postgres schema).
```

Environment variables to set in the Vercel dashboard:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres connection string (`?sslmode=require`) |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `TELEGRAM_CHAT_ID` | your storage channel id |
| `TELEGRAM_API_BASE` | leave unset (hosted) |
| `MAX_UPLOAD_MB` | `4` (Vercel body cap) |
| `MAX_DOWNLOAD_MB` | `20` (hosted `getFile` cap) |
| `SEED_DEFAULT_USER` | `true` (default) — seeds `pufflet@pufflet.com` / `pufflet` |

> The seeded default account is what makes Vercel deploys zero-touch — there is
> no interactive setup wizard on a serverless host. Change the password
> immediately in **Settings → Account** (or set `SEED_DEFAULT_USER="false"`,
> then run the setup screen once).

### Any host (bare Node/Bun)

- Build with `npm run build && npm run start` (or run `bun run dev` behind a
  reverse proxy for personal use). Set `NODE_ENV=production` so session cookies
  are `Secure`.
- **Backups:** schedule `pg_dump`/file-copy of the metadata DB. This backs up the
  *index only* — the bytes live in your Telegram channel, so enable Telegram's
  own export/archival strategy for durability.
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
src/components/pufflet/     UI (store, file list, dialogs, settings, logo)
src/lib/                    services: files, telegram adapter, auth, seed, crypto, …
prisma/schema.prisma        data model (SQLite default; Postgres variant in schema.postgres.prisma)
Dockerfile                  production image (standalone build + boot-time db push)
docker-compose.yml          app + bundled Local Bot API server (2000 MB)
scripts/tg-logout.mjs       one-time hosted->local Bot API migration (npm run tg:logout)
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
  Bot API server
- Folder trash/restore uses shared timestamps: items trashed individually keep
  their own trash time and are not silently restored with the folder
