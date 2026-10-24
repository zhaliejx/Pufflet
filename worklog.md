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
