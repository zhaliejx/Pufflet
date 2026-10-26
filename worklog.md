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

---
Task ID: 18
Agent: main (Z.ai)
Task: User's Render deploy still shows "embedded telegram-bot-api exited immediately" (screenshot: f647f80 live, [bot-api] usage dump) — find exact trigger and fix

Work Log:
- Screenshot confirmed f647f80 deployed (error format "Its output:" + [bot-api] prefixes); pre-flight passed -> env values well-formed, so failure was inside the binary itself; trigger line scrolled off user's phone screenshot
- Reproduced locally WITHOUT docker: pulled the real binary from aiogram/telegram-bot-api registry layers + musl loader/libstdc++/libssl/libcrypto/libz from Alpine CDN, ran on glibc via ld-musl --library-path
- Exact trigger: binary (Bot API 10.3) prints "Option \"logverbosity\" is unrecognized" -> usage dump -> exit. 10.x renamed --logverbosity to -v/--verbosity; binary exits on ANY unrecognized option
- Verified fix live: same binary + args minus --logverbosity -> process stays up, probe answers 404, and getMe with user's real token returns ok:true on the local server (user's api_id 34203910/api_hash valid; bot migration to local server already works — hosted logOut done or unnecessary)
- Fixes: entrypoint drops --logverbosity (arg list now long-stable core flags only, comment warns to check --help of pinned version before adding new flags); Dockerfile pins aiogram/telegram-bot-api:10.3 (latest can remove flags again; 10.3 tag verified on Docker Hub)
- Cleaned .botapi-sim artifacts; branch tests 8/8; committed 9641c5c, pushed main

Stage Summary:
- Root cause was NEVER the user's env values — Bot API 10.3 removed --logverbosity, which the entrypoint still passed
- User action: Render will auto-deploy 9641c5c (or Manual Deploy); expect "using embedded Local Bot API (limits: 2000 MB up / 2000 MB down)" then Ready; Settings should show local (2000 MB)
- Incident trail: effect module fix -> oversized api_id -> --logverbosity removal; entrypoint now guards all three classes (closure deps, bad env shapes, unknown-flag crash visibility)
---
Task ID: 19
Agent: main (Z.ai)
Task: Add vault — at-rest encryption + obfuscation for every file stored in the Telegram channel; transparent decrypt on download

Work Log:
- Explored pipeline: uploads streamed via storeUploadStream -> sendDocument; download routes DID NOT EXIST (getFileForDownload/contentDisposition dead code; UI store.ts already called /api/files/{id}/download; docs/API.md documented /api/v1/files/{id}/download)
- New src/lib/vault.ts: PUFFENC1 container = magic(8)|ver(1)|nonce(12)|padLen u32(4)|AES-256-GCM payload|tag(16), full header as GCM AAD; plaintext payload = 0-64KiB random pad || file (pad inside ciphertext hides sizes); streaming both ways with constant memory (tag-at-end handled by withholding last 16 bytes until flush); obfuscatedStorageName() = pf-<24hex>.bin; mime to TG always octet-stream
- Key custody: PUFFLET_ENCRYPTION_KEY -> scrypt(passphrase,"pufflet-vault-v1",32) never stored; else random 32B key in new Setting model (race-safe upsert + re-read), cached in globalThis, markStateDirty() so the key is snapshotted immediately
- Prisma: +Setting model (sqlite + postgres twins); deploy path already runs prisma db push on boot
- state-backup: SNAPSHOT_VERSION=2 with settings[] (carries vault key through self-heal); parse accepts v1 (settings=[]) for pre-vault pinned snapshots — user's existing Render snapshot restores fine
- files.ts storeUploadStream: encodeUploadStream() before sendDocument; DB size = vault plaintext counter (exact), mime = job.mimeType; sha256 still computed on plaintext pre-vault
- New routes: GET /api/files/[id]/download (session) + GET /api/v1/files/[id]/download (read scope) — peek magic: container -> decrypt+de-pad, legacy -> verbatim passthrough (no key lookup); original name/mime/size headers; ?inline=1 supported
- config: PUFFLET_ENCRYPTION (default on; "false" disables NEW-file encryption only, decode always available) + PUFFLET_ENCRYPTION_KEY
- telegram-mock bug: multipart parser decoded binary as UTF-8 then mixed string/byte indices -> ~5% truncation of random ciphertext (vault correctly failed closed); fixed with latin1 byte-domain parsing; e2e now includes a REAL download roundtrip for the first time
- .gitignore bug: unanchored download/ rule was hiding the new route dirs from git (deploy would have shipped without them); anchored /download/ /upload/ /examples/
- Validation: unit 56/56 (20 new vault cases: round-trip sizes 0B-1MB, 1-byte/odd chunk stress, tamper/truncate/wrong-key fail-closed, legacy passthrough, name/pad properties, service-layer integration with fake storage chat); e2e 37/37 via mock Bot API + real dev server (upload -> ciphertext in mock chat -> transparent decrypt byte-identical; snapshot v2 pins); lint clean; tsc no new errors (fixed DecipherGCM/setAuthTag/Buffer generics + snapshot version narrowing + storeUploadStream opts optional)
- Committed 633b9db, pushed main (token in push URL only)

Stage Summary:
- Everything in the storage chat is now ciphertext under opaque names: AES-256-GCM (AAD-protected header, random 0-64KiB padding), original name/mime/size only in the DB; downloads decrypt transparently; pre-vault files keep working untouched
- User actions: Render auto-deploys 633b9db (db push adds Setting table; next snapshot flush becomes v2 with the vault key). Optional hardening: add PUFFLET_ENCRYPTION_KEY=<long random passphrase> in Render env — key then lives ONLY in env (never in DB/snapshot); losing it loses vault files, so store it safely. Legacy files (uploaded before) download fine as-is; new uploads encrypted from the first one

---
Task ID: 20
Agent: main (Z.ai)
Task: Fix "Telegram file download failed (404)" (TG_DOWNLOAD) on the embedded Local Bot API server + add a no-login Share feature

Work Log:
- Root-caused the 404 by cloning tdlib/telegram-bot-api source AND running the real pinned 10.3 binary (registry-layer extraction): the Local Bot API server has NO /file/bot<token>/<path> HTTP route at all — HttpConnection only routes /bot<token>/<method> and answers 404 "Not Found" for /file/...; verified empirically (real binary: /file/bot → {"error_code":404,"description":"Not Found"}, /bot/getMe → 401 control). Hosted api.telegram.org DOES serve /file/ — which is why downloads broke the moment the embedded server came alive (Task 18), and why the pinned-snapshot restore (same code path) silently failed on reboot
- Local-mode download model implemented in telegram.ts: --local getFile returns the file's ABSOLUTE disk path and the server re-downloads from the Telegram cloud before answering (do_get_file always calls downloadFile) → openDownloadStream now reads bytes via fs.createReadStream from that path; HTTP /file/ kept only for hosted mode (per-segment URL encoding added); localMode derived from resolved base, not the global flag (test-friendly)
- Stale-reference self-heal: when getFile/fetch fail (old file after server restart, GC race), ONE recovery attempt re-sends the document BY file_id (fields-only multipart, buildMultipartStream file part now optional) — re-registers the file with the running server, returns a fresh file_id — then the download is retried and {repaired} is returned; failed recoveries delete the duplicate message (no channel orphans); routes persist repaired ids via files.repairFileReferences (row update + best-effort delete of the replaced message + markStateDirty + audit file.repair); TG_TOO_LARGE/TG_NO_FILE_PATH are fatal (never repaired); state-backup restore passes allowRepair:false
- Share feature: ShareLink model (sqlite+postgres twins; token = 32 random bytes base64url, unique; cascade on file delete) + src/lib/share.ts (create/list/revoke/resolve with uniform 404s — no enumeration oracle, isPublicInlineSafe, ≤20 active links/file, optional expiresInDays ≤10y)
- Routes: session POST/GET/DELETE /api/files/[id]/share; v1 mirrors with scopes (write/read/write); public GET /api/share/[token] (metadata, owner fields never exposed) + GET /api/share/[token]/download (vault-decoded stream, per-IP 30/min rate limit, download counter, audit share.download, inline only for image/video/audio/pdf/text-plain, nosniff); public page /s/[token] (server component, force-dynamic, branded card, image/video/pdf preview, robots noindex)
- UI: ShareDialog in dialogs.tsx (list active links, create → auto-copy URL, per-link downloads count, revoke) wired into file-list Actions (dropdown + context menu, files only) and drive-app
- state-backup: SNAPSHOT_VERSION=3 (+shareLinks; v1/v2 legacy-parse, settings only for ≥2), wipe+restore shareLink rows, counts.shareLinks, restore log line
- telegram-mock: docs now DISK-BACKED — getFile returns absolute tmpdir paths (mirrors real --local), sendDocument supports document=<file_id> re-send (copy semantics), /file/ route kept for legacy; docker-compose: bot-api-data volume now ALSO mounted into the app at /var/lib/telegram-bot-api (absolute paths must resolve in both containers)
- Tests: unit 61/61 (new: local-mode disk read with /file/-never-called assertion, stale-ref repair happy path, failed-repair cleanup, TG_TOO_LARGE no-repair, backup v3/v2/v1 matrix); tsc: telegram.ts narrowing cleanups brought errors 24→20 (rest pre-existing: bun:test imports, mock Bun types, auth users alias, skills/); lint clean
- e2e 49/49 incl. new section 11: share create → public page 200 → meta (owner-data leak grep) → no-login download byte-identical → counter=1 → 401 guards → revoke → 404 → bogus token 404 → v1 create/revoke + revoked-key-401
- Docs: README (feature bullet, "How downloads actually work" verified-model section, Share links section), docs/API.md (share endpoint map + public-links section), docker-compose comment
- Hygiene: .botapi-sim/ (extracted binary) untracked from git + .gitignore'd
- Validation runs: mock+dev server up, e2e full pass after provisioning TELEGRAM_API_BASE/BOT_TOKEN/CHAT_ID for the mock

Stage Summary:
- Downloads now work in EVERY embedded/local-server deployment: local mode reads getFile's absolute disk path (server cloud-re-downloads missing files), hosted keeps the HTTP route, and stale references self-heal via re-send-by-file_id with id persistence + channel cleanup — this also un-breaks the pinned-snapshot restore, so ephemeral-host self-healing works again
- Share links ship end-to-end: UI dialog, session+v1 management APIs, public page/meta/download with rate limiting and revocation, snapshot persistence (v3)
- User action: redeploy; existing /s links survive self-heal; note docker-compose users get the shared volume automatically, external-bot-api hosts must mount the bot-api work dir at the same path for >20MB downloads

---
Task ID: 21
Agent: main (Z.ai)
Task: External PostgreSQL support (Render: stop the per-redeploy index resets) + push the backlog

Work Log:
- Clarified scope with the user's follow-up: persistence complaints = Render ephemeral disk wiping SQLite; they want an external DB wired in. Discovered Task 20's download-fix + share work was already committed (861d8f5) but NOT pushed — origin/main was 15 commits behind, which is why their Render still showed TG_DOWNLOAD 404
- docker/entrypoint.sh: DATABASE_URL provider auto-detection (postgres://|postgresql:// -> postgresql path). Postgres boot = prisma generate --schema prisma/schema.postgres.prisma (regenerates the baked sqlite client in-place; verified 133ms, same musl query engine reused, no download) + prisma db push with 6x10s provisioning retry; --accept-data-loss deliberately NOT set for postgres (durable source of truth — destructive changes abort boot with a clear message; PUFFLET_DB_ACCEPT_DATA_LOSS=1 escape hatch); sqlite path byte-identical to before
- /api/health: databaseProvider field (sqlite|postgresql|unknown) derived from DATABASE_URL scheme — instant post-deploy verification without touching the DB
- Verified app code is provider-portable: only raw SQL in src/ is SELECT 1; no @db native types, no PRAGMA, schemas are byte-twins except the provider line
- README Option B2: new "External database on Render — stop the per-redeploy resets" section (Render Postgres same-region internal string vs external +sslmode=require, Neon/Supabase/Railway work too; boot behavior; first-boot seeding OR auto-restore from a pinned v3 snapshot incl. vault key + share links; honest note that rows only ever in the wiped SQLite file are gone; STATE_BACKUP on = rolling off-site backup, off = DB-only). .env.example comment updated (auto-detect + bare-Node hint)
- Validation: sh -n OK; prisma validate (postgres schema) OK; generate round-trip postgresql<->sqlite OK (local client restored); unit 61/61; lint clean; production build EXIT=0 (first attempt hit a transient sandbox font-fetch error on Baloo_2, rerun clean) + standalone assembled
- Pushed origin/main (16 commits incl. the Task 20 backlog — user's Render was deploying pre-Task-20 code)

Stage Summary:
- Set DATABASE_URL to any postgres:// connection string (Render Internal URL or external with ?sslmode=require) and the index — users, password, folders, files, API keys, share links — persists across redeploys/sleeps; /api/health shows databaseProvider; empty external DB + pinned snapshot = automatic migration restore on first boot; file bytes were always durable in the storage chat
- User action: Render -> New PostgreSQL (same region) -> add DATABASE_URL to the web service -> redeploy; keep STATE_BACKUP on as the off-site index backup

---
Task ID: 21-b (push addendum)
Agent: main (Z.ai)
Task: Deliver the 16-commit backlog to origin/main

Work Log:
- User supplied a GitHub PAT in chat; pushed main:main via explicit URL (4fdafa6..aabc81b, 16 commits incl. the whole Task 20 download-fix + share backlog and Task 21 external-DB support); token used ephemerally in the push URL only — never stored in git config, remotes, files, or the worklog; advised rotation since it transited chat history
- origin/main now = aabc81b; Render auto-deploy will pick it up

Stage Summary:
- Backlog delivered: user's Render was running pre-Task-20 code (hence the persistent TG_DOWNLOAD 404); after this deploy the 404 fix + no-login share links + external-Postgres support all go live

---
Task ID: 22
Agent: main (Z.ai)
Task: Pufflet upgrade — file previews for every type, reliable automatic backups, modern UI + 5-theme system, better navigation; push commits

Work Log:
- Recon: read drive-app/file-list/dialogs/settings-panel/store/logo/auth-screen, globals.css, backup API, share page; confirmed next-themes already in deps, download endpoints already support ?inline=1
- BACKUPS (state-backup.ts + 2 new routes + audit): (1) serializeVerifiedSnapshot — parse-round-trip proof BEFORE upload, corrupt builds never replace the pinned good copy; (2) empty-index overwrite guard — flush refuses to overwrite a good backup with a 0-user snapshot (wiped/failed DB can no longer destroy the only index copy); (3) cold checkpoint ring — every 12h a fresh checkpoint message (max 3, ring in Setting table incl. file ids) so the previous good snapshot survives a bad hot edit; boot restore falls back pinned -> newest usable checkpoint; (4) explicit restore API: POST /api/backup/restore (pinned | checkpoint-by-id, id validated against the ring, 3/10min rate limit, audited) + GET /api/backup/history; Settings -> Data safety now lists previous backups with per-item Restore + destructive-confirm dialog; flush route audited (backup.flush/backup.restore audit actions added)
- PREVIEWS: new preview-dialog.tsx — image (loader+error states), video, audio (branded player card), pdf (iframe + open-in-new-tab), text/code (fetch, 1MB truncate notice, mono render), unsupported kinds -> clean info screen (kind icon, size, mime, format hint, download CTA); row click now opens preview (download moved to menus); grid view got lazy image thumbnails with icon fallback; share page (/s) upgraded: audio player, sandboxed text/code iframe, kind icons, theme-aware card
- THEMES: ThemeProvider (next-themes, class attribute, default system) in layout; FIVE complete themes in globals.css (light refined, dark = new navy-tinted palette, midnight = OLED+violet, sepia = warm paper, system) each defining the full var contract incl. brand gradient + scrollbar + heading vars; .pufflet-gradient/.text-brand-heading/.icon-folder/.icon-file theme helpers replace all hardcoded #283070/#6C9EF9/#9F7DF3 across drive-app/file-list/settings/auth-screen/dialogs/logo wordmark (SVG logo gradients kept as brand asset); ThemeToggle dropdown in topbar (Sun/Moon/Sparkles/Coffee/Monitor SVG icons) + Appearance settings card with visual swatches; preference persisted (localStorage, hydration-safe via useSyncExternalStore useMounted — avoids react-hooks/set-state-in-effect)
- NAVIGATION: sort engine (name A-Z/Z-A, newest, oldest, size) applied client-side to files+folders, persisted; list/grid view toggle persisted; search view now ALSO shows matching folders (client filter of the folder tree) alongside files; mobile sidebar got a backdrop overlay + animated drawer; upload dock/empty states/drag overlay themed; lucide SVG icons only — KIND_EMOJI map + cloud emoji removed from the share page
- Validation: unit 70/70 (9 new guard tests: ring dedupe/trim, checkpoint timing, garbage-in parse, empty-index guard, serialize round-trip); lint clean (fixed set-state-in-effect via useSyncExternalStore; fixed ThemeIcon import path caught by build); production build EXIT=0; dev-server smoke (health/auth-state/share-404-page/auth-guards 401); FULL e2e 49/49 against telegram-mock (uploads, downloads, vault, share, rate limits); NEW endpoint checks: history returns pinned+checkpoint metadata, restore rejects unrecorded message ids, REAL restore round-trip restored 4 files/6 folders/6 users matching checkpoint metadata exactly
- No schema changes, no API contract changes, no data migrations — existing accounts/files/folders/auth fully preserved (e2e proves it)

Stage Summary:
- Every file type now previews in-app (native viewers + honest info screen for the rest); backups are fail-safe (verified serialize, empty-index guard, 12h cold checkpoints, one-click restore from pinned or checkpoint); UI ships 5 cohesive themes with saved preference; navigation gained sorting, persisted view mode, folder search hits, mobile drawer polish; SVG-only iconography throughout

---
Task ID: 23
Agent: main (Z.ai)
Task: Pufflet improvements — faster file loading, better layout, backup verification, upload experience, bulk file management, storage dashboard, sharing, API docs, trash & recovery; test everything and push

Work Log:
- Recon: read every service/route/component touched (files.ts, state-backup.ts, share.ts, store.ts, drive-app, file-list, dialogs, settings-panel, preview-dialog, telegram.ts, all API routes, e2e script, schema) before changing anything
- BASELINES: tsc 21 pre-existing errors (tests/mocks/skills/auth only); perf harness (scripts/perf-bench.mjs) seeded 40 folders × 50 files with realistic ~90-char Bot API file_ids into the dev DB and measured via HTTP: folder listing 10.4ms / 30,820 B, search 8.9ms / 24,871 B, recent 8.7ms / 31,147 B
- PERF backend: listFiles now selects metadata-only columns (tg chat/message/file ids, sha256, uploaderLabel never leave the server — also a privacy win), adds limit/offset + exact total (default 300, max 1000, recent capped 50), list routes send cache-control: no-store; download routes (session, v1, public share) gained ETag "<fileUniqueId>-<size>" + If-None-Match→304 short-circuit BEFORE any Telegram round-trip, inline responses private max-age=3600, attachments stay no-store; inline previews/thumbs no longer spam file.download audit rows
- PERF measured after: folder 30,820→13,677 B (−56%), search →10,862 B (−56%), recent back to 13,679 B (50-file cap restored); large folders now bounded by pagination; 304s make repeat previews/thumb loads nearly free (no TG fetch)
- PERF client: store rewritten — SWR listing cache (20s TTL, LRU 24, cleared on every mutation) paints navigations instantly then revalidates; loadMore() merges offset pages; DriveApp subscribes per-slice (upload progress ticks no longer re-render app shell), FileList memoized, upload completions trigger ONE debounced refresh per burst (was one full refresh per file)
- BACKUPS (state-backup.ts): buildSnapshotData now reads all six tables inside ONE transaction (torn reads during a concurrent move/upload could previously embed a file whose folder row was missing → FK violation that crashed every future restore of that snapshot); pruneDanglingRefs (pure, unit-tested) drops rows whose owner/folder/file/creator relations point outside the snapshot at RESTORE time (fixpoint for deep chains) so torn snapshots restore instead of failing; empty-index guard hardened — pin existence probed as found/absent/UNKNOWN and "unknown" now refuses a 0-user flush; verifySnapshotUpload compares Telegram-reported size vs local bytes (truncated upload = failed flush, ring not advanced); uploadOnce gives transient faults one bounded retry; all flush/checkpoint/restore failures log server-side [state-backup] lines without secrets
- BACKUP TESTS: 8 new unit tests (consistent snapshot zero-copy fast path, missing-folder file drop, deep orphan chain, missing-owner subtree, api-key/share-link pruning, size-verify matrix); REAL recovery test against the running Node production build: restore-from-pinned wiped the DB and rebuilt it exactly (2013 files incl. trash, 48 folders, 5 users, 6 API keys, 6 share links; login + listings verified post-restore); /api/backup/history shows pinned + checkpoint ring
- UPLOADS: queue engine (concurrency 2, pump/slot model), statuses queued→creating→uploading→finishing→done/failed/canceled, per-item retry + retry-failed (max 3 attempts), accidental duplicate guard (same name+size active → info toast, skipped), "100% — encrypting & storing…" state covers the post-send server window, collapsible dock, auto-trim finished items, clear-finished
- BULK: bulkFileAction/bulkFolderAction services (per-item best-effort, 200-id cap, folder restores shallowest-first), POST /api/files/bulk (trash/restore/purge/star/unstar/move) + /api/folders/bulk; UI: checkbox multi-select in list+grid, Cmd/Ctrl+A, shift-range, indeterminate select-all, sticky selection toolbar (download staggered 350ms, move via BulkMoveDialog, trash/restore/purge with confirm), partial-failure toasts; keyboard: / search, Delete trash selection, Esc clear, ? shortcuts dialog
- DASHBOARD: storageOverview service (stats + trashBytes + Prisma groupBy mimeType → 8 family buckets + last 15 audit events + active share count), GET /api/overview, Dashboard view (metric cards, exact-bytes type bars, activity feed with action labels/icons, backend status) — copy states plainly that no capacity/quota is invented; nav item + sidebar storage meter (measured values only)
- SHARING: ShareDialog gained expiry picker (never/1/7/30/90 days → existing expiresInDays API), per-link created/expiry/downloads + expired badge; GET /api/shares lists ALL the owner's active links with file info; Settings "Sharing" card manages every link (copy/open/revoke, file-in-trash + expired badges); capability-token model documented honestly (no per-user ACLs exist)
- TRASH: trashed folders now visible and restorable/purgeable from the trash view (were invisible in the UI before); emptyTrash purges folders deepest-first after files and reports {purged, foldersPurged, failed, errors}; recoverable-vs-permanent copy in empty state; confirms everywhere
- BUG FOUND & FIXED (environmental): bun .next/standalone/server.js corrupts streamed response bodies (verified: 27-byte upload downloaded as "CONTROL-TE" + literal "Connection: close", byte-perfect under node on the SAME build) — package.json start switched to node; Docker/Render always ran node via entrypoint so production was never affected
- HISTORY REPAIR: an auto-commit (6aae8f4, UUID message) had swept mid-work state plus junk (prisma/db/bench.db binary, tool-results dumps); reset --soft to 1cd7f2a, junk deleted, .gitignore now covers prisma/db/ + tool-results/, work recommitted as 3 clean commits (beba598 backend, 8272d41 ui, e28ce77 docs+tests)
- VALIDATION: bun test 78/78 (8 new); eslint clean; tsc exactly the 21-error baseline (zero new); production build EXIT=0; FULL e2e 77/77 against the Node standalone + telegram-mock (6 new sections: pagination contract incl. no-tg*-ref leak assertion, bulk files/folders, trash-folders visibility, overview no-invented-capacity assertion, share management + expiry, empty-trash-with-folders)
- docs/API.md rewritten end-to-end: auth, scopes, pagination params, endpoint map, practical curl examples (list/upload/rename/move/bulk/download/trash-purge/share/keys), error-code table, honest limits; matches implementation as verified by e2e

Stage Summary:
- Listing payloads −56% with bounded pages, 304-cached previews, instant back/forward navigation, and a UI that stops re-rendering on every progress tick; uploads are queued/retryable/deduped; multi-select + bulk actions + keyboard shortcuts; dashboard with exact measured numbers (no invented capacity); share links gain expiry UI + owner-wide management; trash finally shows folders and empty-trash covers them; backup snapshot/restore hardened against races, truncation, and torn reads — all verified by 78 unit + 77 e2e checks including a real restore round-trip
- User action: push to origin/main (below) → Render auto-deploys; no schema changes, no migrations, no API contract breaks (files list responses gained a `total` field additively)

---
Task ID: 24
Agent: main (Z.ai)
Task: Pufflet new feature — Direct Google Drive → Pufflet upload; also fix the Android "My Drive" file-picker error path

Work Log:
- Reviewed existing upload pipeline (createUploadJob → storeUploadStream → vault → Telegram) and client store/queue/dock before writing any code
- NEW src/lib/gdrive.ts: parseDriveLink (file/d, open?id, uc?id, usercontent, raw ids; folder + Docs/Sheets/Slides + non-Drive + scheme rejections with actionable messages), driveDownloadUrl (drive.usercontent.google.com + confirm=t; PUFFLET_GDRIVE_BASE test hook), fetchDriveFile (streaming, HTML interstitial handling, extractConfirmForm rebuilds the scan-warning form URL, describeDrivePage maps sign-in/404-robot/quota pages, Content-Disposition RFC5987 parser, MIME→ext fallback name)
- NEW src/lib/remote-import.ts: startRemoteImport (Drive headers → size guard → createUploadJob → background storeUploadStream with uploaderLabel "gdrive"), abort registry wired into DELETE /api/uploads/[id], 15-min hard timeout via AbortSignal.any, 30-min stale-job sweep into FAILED
- NEW POST /api/uploads/remote (session auth, 20/min rate limit): probe=true resolves metadata only; full call returns uploadId immediately (client polls job row like any upload)
- files.ts: storeUploadStream honors opts.uploaderLabel; canceled-check before the final DB write; catch no longer overwrites CANCELED with FAILED (benefits device uploads too)
- UI: Upload button → dropdown (Upload from device / From Google Drive…), new gdrive-dialog.tsx (probe validation with inline errors, Drive SVG icon, sharing requirement copy), store gains uploadFromUrl + remote queue branch + job polling (1.5s, 5-miss watchdog) + stopPolling on cancel/dismiss, dock shows "resolving Drive link…" / "fetching from Google Drive…", uploadFiles now rejects 0-byte picks and .gdoc/.gsheet/.gslides shortcuts with fix-it toasts (the Android "My Drive" picker symptom — browser hands over an empty File)
- telegram-mock: fake /fake-gdrive/ (seed/download/confirmed with public|scan|private modes) so e2e runs without internet
- VALIDATION: bun test 108/108 (30 new); eslint clean; tsc 22 = 21 baseline + 1 same-class bun:test (new test file); production build EXIT=0 with /api/uploads/remote in route manifest; e2e 90/90 (14 new: probe name+size, folder/non-Drive/401/private rejections, import READY + name dedup, BYTE-PERFECT Drive→TG→download roundtrip, scan-page auto-follow); live probe against REAL Google endpoints: real quota page → DRIVE_QUOTA, real "Error 404" robot page (HTTP 200) → DRIVE_NOT_FOUND, unreachable-host mapped; agent-browser end-to-end on the standalone: login → dropdown → dialog → folder-link inline error → successful import → dock "20 B · stored" → "from-drive (2).txt" in listing, zero console errors (download/gdrive-import-verified.png)
- Docs: README feature bullet + "Import from Google Drive" section (incl. why the phone picker fails and the privacy/limits story), .env.example PUFFLET_GDRIVE_BASE hook

Stage Summary:
- Users can now paste a Google Drive share link and the SERVER pulls the file (Drive → Pufflet → Telegram): no phone-side download, no OAuth, encrypted storage as usual. Committed as 3 commits on local main (ed61c4c + 3 new); PUSH PENDING — no GitHub credentials stored in this environment, need a fresh PAT from the user to push (old token was never persisted, rotation already advised)

---
Task ID: 24-b
Agent: main (Z.ai)
Task: Push pending GDrive commits to origin/main with user-supplied PAT

Work Log:
- Verified working tree clean, 3 commits ahead (cc39ef6 gdrive backend, e312f38 ui, 402c257 docs)
- Pushed via explicit URL with embedded PAT (not stored in git config): ed61c4c..402c257 main -> main
- git update-ref refs/remotes/origin/main refs/heads/main to restore tracking; branch now up to date

Stage Summary:
- Google Drive direct import feature is now on origin/main (402c257) → Render auto-deploys. Reminder already given to user: revoke/rotate this PAT after the push since it was shared in chat.

---
Task ID: 25
Agent: main (Z.ai)
Task: Pufflet folder upload — structure-preserving directory uploads (picker + drag-drop)

Work Log:
- Recon: read upload pipeline (uploads route, data sink, store queue, dock), folder services (createFolder/uniqueFolderName/purgeFolder), drive-app drop wiring before writing code
- NEW pure planner planEnsurePaths in folder-utils.ts: find-or-create walk over relative paths — reuses existing ACTIVE same-name folders (Drive semantics), ignores trashed ones, plans parents strictly before children, overlays in-flight creates across sibling paths, validates segments (traversal/forbidden chars/length) and depth (baseDepth of target parent + segments vs config.maxFolderDepth)
- files.ts: ensureFolderPaths service (loads tree once, executes plan, audits folder.create per created folder, caps 2000 paths/request); returns folders map path->id + created count + per-path errors
- Routes: POST /api/folders/ensure-paths (session, 30/min rate limit) + POST /api/v1/folders/ensure-paths (withToken write scope)
- store.ts: uploadFolder(picked, dirs, folderId) — validates segments, aggregates 0-byte/Docs-shortcut/invalid-name skips into batch toasts, ONE ensure-paths round trip, queues each file into its resolved folder with relPath on the UploadItem; dedupe guard now scoped by target folderId (same name+size in different folders is legitimate); 1000-file batch cap
- drive-app.tsx: "Upload folder…" menu item + hidden webkitdirectory input (relPath from webkitRelativePath); drop handler rewritten to walk webkitGetAsEntry() recursively (entries grabbed synchronously, readEntries loop-until-empty, empty dirs reported, unreadable counted), falls back to flat files; overlay copy now "Drop files or folders"
- upload-dock.tsx: relative-path subtitle for folder uploads
- e2e section 18 (12 checks): 401s, 400, one-round-trip tree, idempotent reuse (same ids, created:0), invalid-path errors alongside valid resolution, nested upload into created folder, v1 mirror, trash+purge cleanup; sections 17/18 now self-clean (stale from-drive*/scanned.bin/e2e_up_* removed at start) so repeat runs are deterministic
- BUG (env): a stale standalone server from an earlier session held :3100 with EADDRINUSE — the suite silently ran against the OLD build ("Unknown action"); also learned background servers die between tool calls — server+suite must share one shell invocation
- VALIDATION: bun test 122/122 (14 new planner tests); eslint clean; tsc 23 = 22 pre-existing baseline + 1 same-class bun:test-module (new test file); production build EXIT=0 with both routes in manifest; FULL e2e 102/102 against node standalone; agent-browser on the standalone: login → Upload menu shows "Upload folder…", synthetic DataTransfer drop drove walker→queue→listing roundtrip, zero page errors (download/folder-upload-verified.png)

Stage Summary:
- Pufflet now uploads whole folders with structure intact: picker (webkitdirectory) or drag-drop both route every file into a find-or-created folder tree (one server round trip), with per-file progress/retry/cancel unchanged, relPath shown per dock item, empty dropped folders created, and the same primitive exposed to API users via /api/folders/ensure-paths + /api/v1/folders/ensure-paths. No schema changes, no migrations, no existing behavior altered (device dedupe guard only got folder-scoped).

---
Task ID: 25-b
Agent: main (Z.ai)
Task: Push folder-upload commit to origin/main

Work Log:
- Squashed the environment's UUID auto-commit (1a58e46, worklog-only) into the feature commit for clean history (same repair pattern as Task 23)
- Pushed via explicit URL with embedded PAT: 402c257..a7791ef main -> main; tracking ref updated, branch in sync

Stage Summary:
- Folder upload is on origin/main (a7791ef) → Render auto-deploys. Same standing reminder: the PAT shared in chat should be rotated after use.

---
Task ID: 26
Agent: main (Z.ai)
Task: rclone storage integration — remotes, browse, upload/download transfers, folder sync; committed on main per user instruction (no push/deploy)

Work Log:
- Recon pass over files.ts/auth/api-auth/v1/ratelimit/audit/config/vault/remote-import/settings-panel/store/drive-app/file-list/gdrive-dialog before any code; user directed twice on branch policy — final instruction: ALL WORK ON MAIN, nothing pushed (no Render deploy)
- SCHEMA (both prisma schemas, additive only): RcloneRemote {ownerId, name unique [a-z0-9-], type, configEnc, status, lastError, lastCheckedAt} + RcloneJob {kind push|pull, remotePath, folderId, status QUEUED/RUNNING/DONE/FAILED/CANCELED, totalFiles/doneFiles/skipped/failed, bytes BigInt, lastError} + User relations; db push (non-destructive), prisma generate
- PURE LIB src/lib/rclone.ts: curated backend catalog (s3/gdrive/sftp/webdav/dropbox/onedrive/azureblob/b2/local) with per-type field schemas (secret flags), remote-name validator (lowercase alnum+hyphen only — keeps INI sections + name:path unambiguous), path validator (traversal/control-char/length guards, name:path confusion analyzed — only FIRST colon splits), config sanitizer (whitelisted keys only, control-char rejection, 4 KiB cap), INI builder, secret masking (never echoes credentials), lsjson parser (array + --stat object forms), stderr→error mapping (RCLONE_MISSING/TIMEOUT/REMOTE_NOT_FOUND/REMOTE_AUTH/REMOTE_CONFIG/RCLONE_FAILED)
- CRYPTO src/lib/rclone-crypto.ts: AES-256-GCM config encryption with remoteId as AAD (blobs can't be swapped between rows); key custody mirrors vault: PUFFLET_ENCRYPTION_KEY→scrypt (real at-rest protection), else random key in Setting "rclone.configKey" (documented as obfuscation only)
- EXEC src/lib/rclone-exec.ts: spawn (NO shell) with per-invocation 0700 temp dir + 0600 rclone.conf materialized from the encrypted blob via RCLONE_CONFIG, shredded in finally; whitelisted env (NODE_ENV required by Next's ProcessEnv augmentation; RCLONE_MOCK_STATE passes through for the e2e mock); ops: version, lsjson (--stat/-R/--files-only), mkdir, cat (streaming with started/closed promises — clean 4xx before first byte vs truncated-body after), rcat (stdin pipeline with backpressure, EPIPE-aware); SIGKILL on timeout/abort everywhere
- SERVICE src/lib/rclone-service.ts (+rclone-route.ts error mapping incl. TelegramError): remote CRUD (update merges — client sends "" for "keep stored secret", can never read one), test (lsjson root → status persisted), browse, send (TG→vault-decode→rcat, streaming, no temp files), ingest (stat→size guard→createUploadJob→cat→storeUploadStream uploaderLabel "rclone", UploadJob pollable like device uploads), sync jobs (one active per user, per-file progress rows, per-file failure accounting with poisoned-dir single-count, stale-job sweep 90 min, abort registry for cancel + remote-delete), masked serializers
- ROUTES: 12 session (/api/rclone: status, remotes CRUD, test, browse, download, send, ingest, sync, jobs list/get/cancel) + 11 v1 mirrors with scopes (read: list/browse/download/jobs; write: send/ingest/sync/cancel; admin: remote create/update/delete — they hold credentials) + per-route rate limits; build manifest carries all 23 rclone routes
- UI: RcloneCard in Settings (availability banner, remote rows with status dot + Test/Browse/Edit/Delete, folder-sync form with direction/remote/path/folder, recent-jobs table with live 2.5 s polling while any job is active, delete confirm); RcloneRemoteDialog (dynamic per-backend fields, secrets as password inputs, blank secret = keep on edit); RcloneBrowseDialog (breadcrumbs, dirs-first listing, per-file Download-to-device + Import-into-Pufflet with destination folder picker); RcloneSendDialog (file row menu "Send to rclone…" in dropdown AND context menu, remote select, target path with trailing-/ dir hint)
- TESTS: 31 unit tests (names/paths/sanitize/INI/masking/lsjson incl. --stat/error mapping/version parse/crypto roundtrip + AAD-swap + bit-flip tamper); scripts/rclone-mock.mjs (fake rclone: version/lsjson/--stat/cat/rcat/mkdir over a plain state dir, real-rclone stderr shapes so error mapping is exercised, exit 3 on missing paths); e2e section 19 (28 checks, skip-guarded via PUFFLET_RCLONE_E2E): 401s, 409/400 validation, test/browse, send→byte-diff against mock state, download byte-diff, ingest→Pufflet-download round trip byte-perfect, SECRET-LEAK assertion across session+v1 listings, empty-secret update keeps stored value, push job → DONE + structure byte-compared, pull job → mirrored folders + nested file, v1 read-key 403 on create + admin-key create/delete, remote delete → browse 404; scripts/rclone-live-probe.ts against REAL rclone v1.75.2 (caught a real bug: modern rclone dropped lsjson --links — my "--links false" was parsed as a second positional arg; removed)
- BUGS FOUND & FIXED during validation: (1) spawn overload broken by Next's NODE_ENV-required ProcessEnv → baseEnv typed NodeJS.ProcessEnv; (2) BigInt literals vs tsconfig target → BigInt(0); (3) Prisma include intersection types → Omit<JobRow,"remote"> shapes; (4) parseVersion lived in node-only exec but client needed it → moved to pure lib; (5) e2e envs: zombie "next-server" survives pkill -f "standalone/server.js" (process title renamed) → EADDRINUSE made the suite run a STALE build (recurring trap, now pkill -f next-server + health gate before suite); (6) telegram-mock requires exact token 123456:ABC-mock-local; (7) my own baseEnv whitelist stripped RCLONE_MOCK_STATE so the mock wrote to its default dir while the suite diffed another (rcat "failures" with byte-perfect round trips — the giveaway); (8) TelegramError now mapped in rclone routes (was generic 500), caught by browser-test against a restarted mock
- VALIDATION: eslint clean; bun test 153/153 (31 new); tsc exactly the 24 pre-existing baseline errors (mocks/skills/tests/auth — zero new); production build EXIT=0; FULL e2e 130/130 (102 prior + 28 new) against node standalone + telegram-mock + rclone-mock; real-rclone probe byte-identical round trips; agent-browser on the standalone: login → Settings shows "rclone Storage" card → Add remote dialog (dynamic fields, disabled-until-valid) → s3 remote created (secret NEVER in DOM — innerHTML grep false) → Test connected → Browse dialog opens → file menu shows "Send to rclone…" → send completes, mock state file byte-identical, ZERO page/console errors (download/rclone-ui-verified.png)
- Docs: README feature bullet + "rclone Storage" section (honest: local backend exposes server filesystem, OAuth backends take externally-generated token JSON, sync copies/overwrites without deleting), docs/API.md endpoint map + error codes, .env.example PUFFLET_RCLONE/PUFFLET_RCLONE_PATH, Dockerfile apk add rclone
- Work tree: stray probe artifact a/ removed; test remotes/files/jobs purged from the dev DB

Stage Summary:
- Pufflet can now bridge ANY rclone-supported storage: configure remotes (credentials AES-256-GCM encrypted at rest, row-bound, masked in every response, materialized only into a 0600 temp config per invocation), browse remotes, pull files into the encrypted Telegram pipeline, push files/folders out via streaming rcat, and run cancelable one-at-a-time folder sync jobs with live progress — all mirrored on /api/v1 with read/write/admin scope separation. Verified by 153 unit + 130 e2e checks including byte-perfect Pufflet→remote→Pufflet round trips and a real-rclone live probe; browser-verified UI with zero page errors. Committed on main ONLY as directed — not pushed (Render deploy deliberately not triggered)

---
Task ID: 27
Agent: main agent (Z.ai)
Task: Push the pending rclone commits (862a0f7 backend, 3563f20 UI, 2650771 tests+docs) from local main to origin/main after user supplied a fresh PAT

Work Log:
- Confirmed state before push: on main, working tree clean, 3 commits ahead; plain `git push origin main` failed (no credentials — environment intentionally stores none); verified no ~/.git-credentials, ~/.netrc, ~/.ssh, gh auth or env tokens
- Verified remote main still at 010eddf via git ls-remote (push had not happened elsewhere)
- User supplied a fresh PAT in chat; pushed via explicit URL with embedded token: 010eddf..2650771 main -> main
- Updated tracking ref (git update-ref refs/remotes/origin/main refs/heads/main); git status shows main in sync with origin/main at 2650771
- Leak check: git remote -v clean, no credential/token in git config, token never written to any file or the worklog
- Reminder given to user: revoke/rotate this PAT after push (it transited chat history)

Stage Summary:
- rclone Storage integration is now on origin/main (2650771) → Render auto-deploys the 3-commit feature (23 routes, dual-provider schema, rclone binary added to Dockerfile). PAT used ephemerally in the push URL only — never stored; rotation advised as with previous tokens
