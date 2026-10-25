# Pufflet Worklog

---
Task ID: 1
Agent: main (Z.ai)
Task: Build "Pufflet" Telegram-backed personal cloud storage app per master prompt, recreate logo as SVG, push to github.com/zhaliejx/Pufflet

Work Log:
- Loaded fullstack-dev skill, initialized environment
- Inspected scaffold: Next.js 16 App Router, Prisma (SQLite), shadcn/ui, Tailwind 4, bun
- Verified remote repo zhaliejx/Pufflet exists and is empty (ls-remote exit 0, no refs)
- Reviewed logo PNG: kawaii 3D cloud, blue-purple gradient, navy eyes/smile, sparkle dashes, "Pufflet" navy rounded wordmark

Stage Summary:
- Plan: SVG logo → Prisma schema → core libs → services → API routes → UI → tests/verify → docs → git push

---
Task ID: 2-9
Agent: main (Z.ai)
Task: Build the complete Pufflet application

Work Log:
- SVG logo: scripts/gen_logo.py (Baloo2 ExtraBold wordmark → vector paths + hand-built cloud icon); fixed librsvg blur-clip artifact by switching shadow to radial gradient; outputs public/logo.svg, public/logo-icon.svg, src/app/icon.svg
- Prisma schema: User/Session/Folder/File/UploadJob/ApiKey/AuditEvent with indexes; SQLite build, Postgres port documented
- Core libs: config, crypto (scrypt + 256-bit API tokens, sha256-at-rest), ratelimit (failures-only login window + peek/reset), audit, auth (DB sessions in httpOnly cookies), api-auth (Bearer tokens + scopes), telegram adapter (streaming sendDocument via hand-built multipart, getFile download stream, deleteMessage, retry/backoff, injectable fetch), multipart builder (zero-copy streaming), folder-utils (pure cycle guard), files service (uploads state machine, trash w/ shared-timestamp subtree restore, purge Telegram-first, dedup, search, stats)
- API routes: auth (state/setup/login/logout), uploads (job + raw PUT data + status/cancel), files (list/meta/patch/trash/restore/purge/download), folders, keys, stats, health, trash empty, full /api/v1 token API with scope enforcement
- UI: single-page app — first-run owner setup, login, Drive-style shell (sidebar, search, breadcrumbs, list/grid, drag-drop upload w/ progress dock, context menus, dialogs for folder/rename/move/confirms, trash flows, settings with API-key manager + one-time token reveal + storage stats + telegram status)
- Tests: 29 unit tests (crypto/scopes/cycles/multipart/telegram-mocked) + 30-step E2E API suite against mini-services/telegram-mock (in-memory mock Bot API on :3031)
- Bug fixes found BY tests/browser: NextResponse missing import (setup 500), inverted folder-cycle detection (walk-up fix + data cleanup), login limiter counting successes (failures-only redesign), settings "Invalid view" fetch, unmasked chat id, dialog a11y warning
- Verification: lint clean, 30/30 E2E pass, 29/29 unit pass, agent-browser E2E: setup→login→folder create→drag-drop upload→star→rename→trash→restore→settings→API key create (one-time reveal)→mobile viewport
- Docs: README (architecture, verified Bot API limits 50MB up/20MB down hosted, 2000MB local, setup, testing, deployment, security, limitations), .env.example (placeholders), docs/API.md (endpoint map, scopes, examples)

Stage Summary:
- App fully working locally against mock Telegram storage; round-trip byte-identical downloads verified
- Ready to commit & push

---
Task ID: 10
Agent: main (Z.ai)
Task: Push to github.com/zhaliejx/Pufflet (token used for push only, never committed)

---
Task ID: 11
Agent: main (Z.ai)
Task: Add bundled Local Bot API server + default seeded account (pufflet@pufflet.com/pufflet) with Settings password change + Vercel deployment guide

Work Log:
- Schema: User.mustChangePassword added (db push); postgres variant generated to prisma/schema.postgres.prisma (source of truth stays schema.prisma)
- Seeding: src/lib/seed.ts — ensureDefaultUser() creates pufflet@pufflet.com with temporary password "pufflet" (7 chars, on purpose) + mustChangePassword=true when users table empty; SEED_DEFAULT_USER="false" opts out; wired into GET /api/auth/state (returns defaultUserActive + user.mustChangePassword)
- New POST /api/auth/change-password: session-auth, rate-limited (10/15min), verifies current pw, 8-200 char + must-differ validation, scrypt rehash, clears mustChangePassword, revokes all OTHER sessions, audit auth.password_change
- UI: login screen shows first-run hint while defaultUserActive; fixed login minLength=8 bug that would have blocked the 7-char temp password; DriveApp amber "temporary password" banner with jump-to-settings button; Settings got an Account card (current/new/confirm + temporary-password badge); telegram status badge now shows storage mode local (2000 MB) vs hosted (50 MB) via new USING_LOCAL_BOT_API const + telegramStatus().mode
- Bundled Local Bot API: Dockerfile (bun build -> node:22-slim standalone runtime, prisma db push entrypoint, non-root), docker-compose.yml (app + aiogram/telegram-bot-api sidecar with --local, MAX_*_MB=2000, volumes), .dockerignore, scripts/tg-logout.mjs (one-time hosted logOut migration, npm run tg:logout)
- Vercel: vercel.json build command generates prisma client from postgres schema; README Deploying rewritten: Option A Docker+Local Bot API (logOut caveat: old file_ids die), Option B Vercel (honest ~4.5MB serverless body cap -> MAX_UPLOAD_MB=4, Neon/Vercel Postgres steps, env table), .env.example documents all new vars
- Verification: lint clean, 29/29 unit tests, API matrix (wrong-current 400 / short 400 / same 400 / valid 200 / unauth 401 / old-pw 401 after change), agent-browser E2E: login hint visible -> pufflet/pufflet login -> banner -> Settings Account card -> in-browser password change -> banner cleared after reload -> new password works -> reset DB to clean seeded state for preview

Stage Summary:
- Fresh instance is now zero-touch: sign in pufflet@pufflet.com/pufflet, change pw in Settings -> Account
- 2000 MB mode = docker compose up -d (bot-api sidecar included in repo)
- Committed & pushed to github.com/zhaliejx/Pufflet (main)

---
Task ID: 12
Agent: main (Z.ai)
Task: No-VPS run story — self-healing state backup to Telegram + all-in-one Docker image (embedded Local Bot API) + Vercel-first deploy docs

Work Log:
- New src/lib/state-backup.ts: serializes index (users/folders/files/apiKeys; sessions+jobs+audit excluded) into one pinned JSON document in the storage chat; flush reuses the SAME message via editMessageMedia (no chat spam), pins via pinChatMessage, falls back to fresh send if deleted; boot-time restoreIfEmpty() reads getChat -> pinned_message, downloads, restores in one transaction with ids preserved (folders linked in a second pass); ensureStateBoot() once-guarded per process; markStateDirty via audit() choke point (STATE_TRACKED set); auto flush timer (default 60s, unref'd, globalThis-guarded)
- config: STATE_BACKUP (default true), STATE_BACKUP_INTERVAL_MS (default 60000)
- telegram.ts: optional TelegramClientLike extras getChatPinnedDocument/editMessageDocument/pinChatMessage (real impl added; test mocks unaffected); createTelegramClient now accepts explicit {apiBase,botToken,chatId} overrides
- Fixed latent test bug: unit suite's config singleton depended on bun auto-loaded .env + import order (telegram tests hit the mock service URL); telegram.test.ts now builds clients with explicit OPTS, no env fiddling
- Boot wiring: src/instrumentation.ts register() + GET /api/auth/state both call ensureStateBoot (restore-if-empty then start timer, never throws)
- New API: GET /api/backup (status), POST /api/backup/flush (session + 10/5min rate limit); Settings -> new "Data safety" card (auto-backup badge, unsaved-changes badge, last snapshot time/size, Back up now button, do-not-unpin warning, mobile-friendly)
- Login limiter redesigned: verify credentials FIRST, throttle only failures (peek before counting); correct passwords always sign in and reset the bucket — a burst of wrong guesses can no longer lock the owner out (found via back-to-back e2e runs poisoning the bucket)
- Dockerfile rewritten ALL-IN-ONE: bun:1-alpine builder (musl native deps) + aiogram/telegram-bot-api binary copied into node:22-alpine runner; entrypoint starts embedded bot-api on :8081 loopback ONLY when TELEGRAM_API_ID+HASH set (auto TELEGRAM_API_BASE/2000MB limits), waits via node fetch probe; PORT default 7860 (HF Spaces), user node (uid 1000); compose keeps sidecar mode (API_ID/HASH not passed to app) and sets PORT=3000 explicitly
- telegram-mock: added getChat/pinChatMessage/editMessageMedia (multipart part "pufflet_state", message_id form-field parsing, in-place document replacement); parseMultipart generalized with part name param
- e2e: new section 0 (idempotent bun -e seed of owner@pufflet.test — suite assumed a user that DB resets wipe), section 10 state backup (401 guard, flush, status, second-flush edits-in-place, pinned discoverability via mock getChat); per-run X-Forwarded-For IP so in-memory limiters never collide across runs; unique api-file-$RANDOM name
- README Deploying rewritten: Option A Vercel (explicit Neon/schema/env steps, honest 4MB cap, STATE_BACKUP=false), Option B Hugging Face Spaces FREE no-VPS 2000MB (front-matter yaml, secrets, tg:logout caveat, sleep/restore behavior), Option C any Docker host; new "State backup" doc section; storage-channel setup now requires pin-messages right; .env.example force-added (was silently gitignored and never pushed!)
- Verification: lint clean; 36/36 unit tests (new backup.test.ts: snapshot round-trip, version guards, applySnapshotData wipe-order/folder-link-order/date revival with fake tx); e2e 37/37 twice back-to-back; agent-browser: login -> Settings Data safety card renders (desktop+mobile), auto-backup already fired live ("1 min ago, 15.6 KB"), Back up now -> "Snapshot saved" toast, 429 path handled with clear message; no page errors

Stage Summary:
- Pufflet now survives ephemeral hosts: restart wipes disk -> boot restores index from the pinned Telegram snapshot in seconds
- 2000 MB mode needs NO VPS: one free HF Space runs app + embedded Local Bot API from the same image
- Vercel path documented and de-risked (login limiter fix + STATE_BACKUP=false guidance)
- Committed & pushed to github.com/zhaliejx/Pufflet (main)

---
Task ID: 13
Agent: main (Z.ai)
Task: Wire user-deployed remote Bot API server (Render) into Pufflet's Vercel deploy story

Work Log:
- User deployed their own self-hosted Bot API on Render (telegram-bot-api-cylx.onrender.com); probed it: root returns canonical bot-api 404 JSON, /bot<fake>/getMe returns 401 Unauthorized -> confirmed a live Local Bot API server
- Confirmed Vercel platform facts via docs: 4.5 MB request-body cap (uploads ~4 MB regardless of backend), Fluid compute Hobby max duration 300s (downloads stream fine), Hobby 100GB data / 10GB origin transfer
- Verified code paths need no changes: adapter builds downloads as {base}/file/bot<token>/<path> (requires --local on the server), USING_LOCAL_BOT_API auto-flips to "local (2000 MB)" when TELEGRAM_API_BASE != hosted, 120s callApi timeout absorbs Render cold starts
- README: constraints table generalized (self-hosted server anywhere, not just bundled); Option A rewritten as "Vercel + your own Bot API server" (Render setup via aiogram/telegram-bot-api image + --local command, mandatory tg:logout step, env table with TELEGRAM_API_BASE + MAX_UPLOAD_MB=4 + MAX_DOWNLOAD_MB=2000, keep-awake pinger note, bandwidth budgets, security note); Option B now flagged as the free path for 2000 MB uploads; known-limitations bullet updated
- .env.example: remote self-hosted TELEGRAM_API_BASE example; docker-compose.yml: fixed stale "Option A" README reference
- lint clean, 36/36 unit tests pass; committed + pushed (token used in push URL only, remote kept clean)

---
Task ID: 14
Agent: main (Z.ai)
Task: User pivots to "set this up on HF space (static)" — HF Spaces deployment path (2GB uploads, no Vercel)

Work Log:
- Clarified: HF "Static" SDK only serves fixed HTML — Pufflet needs the Docker SDK (free); documented in README Option B
- Probed user's bot (token provided in chat): @Pufflet_bot, still HOSTED-logged-in; their Render service (telegram-bot-api-cylx.onrender.com) answers getMe AND getUpdates identically to hosted — impossible for a real local bot-api (which locks the bot exclusively) -> it's a passthrough/proxy with hosted's 50/20MB limits, not 2000MB
- Built scripts/deploy_hf.mjs (zero-dep Node): whoami-v2 verification (write role enforced), auto-discovery of storage chat via hosted getUpdates + getChatMember admin validation, Space creation via /api/repos/create (409 tolerated), code push via git clone + git archive HEAD (tracked files only — .env/db never leave machine), HF front-matter README (sdk: docker, app_port: 7860), 4 secrets via /api/spaces/{id}/secrets, optional --logout (one-time hosted logOut, gated), build polling (15s interval, 15min window, terminal-stage detection)
- Tested: node --check, usage path, fake-token rejection (clean 401 before any mutation); real run pending user's HF token
- README: Option B now has wizard tip + one-command example; repository layout lists the script
- Committed & pushed (eb40c53); bot NOT logged out yet — script does it with --logout at deploy time (bot idle, safe either way)

Stage Summary:
- User can deploy by pasting an HF write token (I run the script) or running it themselves
- Pending from user: HF write token, api_id/api_hash, (chat id auto-discovered if a message was posted in the channel recently)
- After Space is live: delete/suspend the Render proxy service (no longer needed)

---
Task ID: 15
Agent: main (Z.ai)
Task: Fix Render deploy crash "Error: Cannot find module 'effect'" (all-in-one Docker boot)

Work Log:
- Reproduced locally with an isolated sim (parent node_modules hidden): entrypoint's `node node_modules/prisma/build/index.js db push` dies from @prisma/config/dist/index.js requiring 'effect' — exact user error/stack from Render logs
- Root cause: bun.lock drifted prisma 6.11 -> 6.19.2; @prisma/config@6.19.2 declares effect@3.18.4 (+c12/fast-check/jiti/chokidar/... ~35-pkg closure) while the Dockerfile runner copied only node_modules/prisma + @prisma + .prisma
- Confirmed next@16.1.3 does NOT use effect (standalone app clean); verified next has no require('effect') in dist
- Dockerfile fix: builder stage now creates a self-contained prisma CLI install (/prisma-cli, bun resolves full closure from the same locked prisma version) and grafts the main install's pre-downloaded @prisma/engines; runner copies /prisma-cli/node_modules (merges into standalone's traced node_modules) + .prisma + prisma/ schema
- Verified end-to-end via simulated runner assembly (standalone + prisma-cli node_modules + schema + entrypoint, parent node_modules hidden): db push OK, Next ready in 78ms, /api/health {"ok":true,database:up}, /api/auth/state defaultUserActive:true; old subset repro crashed, new assembly boots clean
- README: new "Option B2 — Render (free tier, same all-in-one image)" (Docker runtime auto-detect, port/health-check notes, env matrix: TELEGRAM_API_BASE external server vs TELEGRAM_API_ID/HASH embedded 2000MB, ephemeral-disk caveats — embedded bot-api file cache dies on restart on free tier, Disk at /app/db for paid); Option C heading trimmed; cross-ref updated
- Housekeeping: killed leftover sim server, removed .sim; lint clean again (8 lint errors were .sim build output being scanned), 36/36 unit tests pass
- Committed 295fe53, pushed to main (token in push URL only)

Stage Summary:
- Render deploy crash root-caused (Prisma 7-style CLI closure debt arrived in 6.19) and fixed at the Dockerfile level so any future closure growth is auto-resolved by bun
- User action: Render auto-deploys on push — watch the new build; boot log should show "[pufflet] syncing database schema (prisma db push)..." followed by "Ready"

---
Task ID: 16
Agent: main (Z.ai)
Task: Diagnose Render "No open ports detected" after effect fix; harden entrypoint boot path

Work Log:
- Read user's Render log screenshot (deploy 295fe53): db push now passes (effect fix confirmed live on Render); visible log line is telegram-bot-api printing its USAGE text (--proxy=<arg> ... webhook) -> binary exits on invalid args
- Root cause: user's embedded-mode env rejected — almost certainly TELEGRAM_API_ID not a plain number (quotes/spaces pasted, or api_hash in the id field); old entrypoint then probed the dead server 120x0.5s (~60-80s incl. node spawn) before starting Next.js, so Render's port scan saw nothing ("No open ports detected, continuing to scan...")
- docker/entrypoint.sh hardened: TELEGRAM_API_ID numeric validation (case *[!0-9]*) -> skip embedded with loud warning; wait loop now kill -0 fail-fast when the bot-api process dies; graceful fallback (no TELEGRAM_API_BASE export -> hosted limits) instead of pointing the app at a dead :8081; active boot mode logged for all three paths (embedded/external/hosted); readiness wait capped at 45s
- New scripts/test-entrypoint.sh: stub-based POSIX branch tests, all 5 cases pass (non-numeric skip, instant-death fail-fast, healthy embedded w/ 2000MB, external base, hosted)
- README Option B2: TELEGRAM_API_ID must be plain numeric clarification
- Committed 92da261, pushed (token in push URL only)

Stage Summary:
- Boot path can no longer stall ~80s or silently point at a dead embedded server; every boot logs its storage mode
- User actions: fix/clean TELEGRAM_API_ID+HASH values (or switch to TELEGRAM_API_BASE-only mode), redeploy 92da261; if it still fails, send the [pufflet] log lines

---
Task ID: 17
Agent: main (Z.ai)
Task: User provided real api_id (34203910) + api_hash (32-hex); harden entrypoint pre-flight checks; produce Render env-table copy-paste block

Work Log:
- Confirmed root cause of "embedded telegram-bot-api exited immediately" from official source: --api-id parsed via to_integer_safe<int32> -> values > 2147483647 (e.g. bot-token prefix 8768064067) print usage and exit; empty api_hash also exits ("You must provide valid api-id and api-hash")
- User's new values validated by shape: 34203910 numeric + in int32 range, hash is 32 hex chars -> embedded mode will boot this time
- entrypoint.sh: pre-flight targeted checks (non-numeric / out-of-int32-range with "that's the BOT id not api_id" hint / hash not 32-hex with actual length echoed); bot-api stdout+stderr now captured to $BOT_API_DIR/bot-api.log and last 20 lines echoed with [bot-api] prefix on instant exit; mkdir -p work dir tmp subdir; fixed leftover case ;;/esac + missing fi from restructure (caught by sh -n)
- scripts/test-entrypoint.sh: 8 cases now (quotes, bot-token-prefix 8768064067, zero, bot-token-as-hash, instant-death w/ captured output, healthy embedded, external, hosted) — all pass
- README Option B2: where to get api_id/api_hash (my.telegram.org -> API development tools, phone login), bot-token-prefix pitfall, one-time hosted logOut via browser URL https://api.telegram.org/bot<TOKEN>/logOut before/while deploying (up to 10 min to take effect)
- lint clean, 36/36 unit tests; committed f647f80, pushed main (token in push URL only)

Stage Summary:
- User's Render env table should contain exactly: TELEGRAM_API_ID=34203910, TELEGRAM_API_HASH=<32-hex>, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — and must DELETE TELEGRAM_API_BASE (Render proxy) or embedded limits/auto-config get bypassed
- Critical pending step for user: one-time hosted logOut (bot still logged into hosted API) or local-server Telegram calls will 409/fail; old hosted file_ids die after logOut
