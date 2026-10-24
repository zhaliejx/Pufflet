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
