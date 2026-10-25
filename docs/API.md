# Pufflet REST API (`/api/v1`)

Programmatic access to your Pufflet storage. Every `/api/v1` request is
authenticated with an API token created in **Settings → API keys** (or via the
key-management endpoints below).

```
Authorization: Bearer tc_live_xxxxxxxxxxxxxxxx
```

- Tokens are shown **once** at creation. Only a SHA-256 hash is stored server-side.
- Send tokens in the `Authorization` header — never in URLs, logs, or client code.
- All responses are JSON except file downloads (raw bytes).
- Errors are uniform: `{"error":{"message":"…","code":"…"}}` — messages are safe
  to display; internals never leak.

## Token scopes

| Scope | Operations |
|---|---|
| `read` | list/get files & folders, downloads, storage overview |
| `write` | create upload jobs, PUT bytes, create folders, rename/move/star/restore, create share links |
| `delete` | move to trash, permanent delete (single or bulk) |
| `admin` | create/list/revoke API keys (implies everything) |

Requests without the required scope get `403`; without a valid token `401`.

## Pagination, sorting & listing performance

`GET /api/v1/files` returns **metadata only** — the internal Telegram storage
references never leave the server. Responses carry `{ files, total }`:

| Param | Values | Default |
|---|---|---|
| `view` | `folder` \| `recent` \| `starred` \| `trash` \| `search` | `folder` |
| `folderId` | folder id (for `view=folder`) | root |
| `q` | search text (for `view=search`, case-insensitive substring) | — |
| `sort` | `name` \| `size` \| `updatedAt` | `updatedAt` |
| `dir` | `asc` \| `desc` | `desc` (`asc` for name) |
| `limit` | 1–1000 | 300 (recent is capped at 50) |
| `offset` | ≥ 0 | 0 |

`total` is the count of the whole (unpaged) result — load pages until
`files.length >= total`. Listing responses are `cache-control: no-store`.

Downloads support conditional requests: inline responses carry an `ETag`
(`"<fileUniqueId>-<size>"`); sending `If-None-Match` with a matching revision
answers `304` without touching Telegram storage. Inline responses are cached
privately by the browser for 1 hour; attachment downloads are `no-store`.

---

## Endpoint map

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/api/v1/me` | — | Who am I (user + token scopes) |
| GET | `/api/v1/files` | read | List files (`{files, total}`; params above) |
| POST | `/api/v1/files` | write | Create an upload job |
| GET | `/api/v1/files/{id}` | read | File metadata (storage refs masked) |
| PATCH | `/api/v1/files/{id}` | write | Rename (`{name}`), move (`{folderId}`), or star (`{starred}`) — one at a time |
| DELETE | `/api/v1/files/{id}` | delete | Move to trash (recoverable) |
| DELETE | `/api/v1/files/{id}?permanent=1` | delete | **Irreversibly** delete (Telegram message too) |
| POST | `/api/v1/files/{id}?action=restore` | write | Restore from trash |
| POST | `/api/v1/files/bulk` | varies | Multi-select operations (below) |
| GET | `/api/v1/files/{id}/download` | read | Stream the file (`?inline=1` for browser preview) |
| POST | `/api/v1/files/{id}/share` | write | Create a public share link (`{expiresInDays?}`) |
| GET | `/api/v1/files/{id}/share` | read | List the file's share links |
| DELETE | `/api/v1/files/{id}/share?linkId={id}` | write | Revoke a share link |
| GET | `/api/v1/folders` | read | List folders (`all=1` includes trashed, with `trashedAt`) |
| POST | `/api/v1/folders` | write | Create folder (`{name, parentId?}`) |
| PATCH | `/api/v1/folders/{id}` | write | Rename (`{name}`) or move (`{parentId}`) |
| DELETE | `/api/v1/folders/{id}` | delete | Trash subtree |
| DELETE | `/api/v1/folders/{id}?permanent=1` | delete | Purge subtree |
| POST | `/api/v1/folders/{id}?action=restore` | write | Restore subtree |
| POST | `/api/v1/folders/bulk` | delete/write | Bulk trash/restore/purge folders |
| POST | `/api/v1/uploads` | write | Create an upload job (alias of `POST /files`) |
| GET | `/api/v1/uploads/{id}` | read | Job status: `PENDING→UPLOADING→STORING→READY/FAILED/CANCELED` |
| DELETE | `/api/v1/uploads/{id}` | write | Cancel a job |
| PUT | `/api/v1/uploads/{id}/data` | write | Send the raw bytes |
| GET | `/api/v1/keys` | admin | List API keys |
| POST | `/api/v1/keys` | admin | Create an API key |
| DELETE | `/api/v1/keys/{id}` | admin | Revoke an API key |

Website-only endpoints (session cookie, not tokens): `/api/stats`,
`/api/overview`, `/api/shares`, `/api/backup*`, `/api/trash/empty`, `/api/auth/*`,
and the `/api/files…`/`/api/folders…` mirrors. Use `/api/v1` for scripts.

---

## Practical examples

### List a folder (paged)

```bash
curl -s "https://your-pufflet/api/v1/files?view=folder&limit=50&sort=name&dir=asc" \
  -H "Authorization: Bearer $TOK"
# → {"files":[{"id":"…","name":"a.pdf","size":123,"mimeType":"application/pdf",
#      "status":"READY","starred":false,"folderId":"…","createdAt":"…","updatedAt":"…"}],
#     "total":137}
```

### Upload (two steps)

```bash
# 1) create a job
curl -s -X POST https://your-pufflet/api/v1/files \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"filename":"report.pdf","size":123456,"mimeType":"application/pdf","folderId":null}'
# → {"uploadId":"…","putTo":"/api/v1/uploads/…/data"}

# 2) PUT the raw bytes (streamed to Telegram storage, never buffered whole)
curl -s -X PUT "https://your-pufflet/api/v1/uploads/$UPLOAD_ID/data" \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @report.pdf
# → {"file":{"id":"…","name":"report.pdf","size":123456,…}}
```

The file becomes visible (`status=READY`) only after Telegram storage succeeds
and the metadata row commits. A re-PUT on the same job is idempotent; a failed
job can be retried by PUT again or canceled with `DELETE /uploads/{id}`.
Duplicate names are auto-de-duplicated (`report.pdf` → `report (2).pdf`).

### Rename, move, star

```bash
curl -s -X PATCH "https://your-pufflet/api/v1/files/$FILE_ID" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"name":"renamed.pdf"}'
# move: -d '{"folderId":"$FOLDER_ID"}'   (null = root)
# star: -d '{"starred":true}'
```

Rename and move must be sent as separate requests (sending both returns 400).

### Bulk operations

```bash
curl -s -X POST "https://your-pufflet/api/v1/files/bulk" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"action":"trash","ids":["id1","id2","id3"]}'
# → {"ok":true,"succeeded":3,"failed":0,"errors":[]}
```

- File actions: `trash` `restore` `purge` `star` `unstar` `move` (move takes
  `folderId`, `null` = root). Scope: `write`, except `trash`/`purge` → `delete`.
- Folder actions (`/api/v1/folders/bulk`): `trash` `restore` `purge`. Restores
  run shallowest-first so parents come back before their children.
- Per-item best-effort: one failing id never blocks the rest; `errors[]` lists
  each `{id, error}`. Max 200 ids per call.
- Individual operations still write audit events, so bulk results appear in
  activity feeds like single ones.

### Download

```bash
curl -sL "https://your-pufflet/api/v1/files/$FILE_ID/download" \
  -H "Authorization: Bearer $TOK" -o report.pdf
```

Streams through the server; the bot token never appears in any URL handed out.
The response carries the original filename, mime type and byte size. Vault
containers (AES-256-GCM, on by default) are decrypted transparently — you
always receive the original bytes. Files uploaded before the vault existed are
served verbatim. Add `?inline=1` for browser-safe inline serving.

### Delete (trash → purge)

```bash
# recoverable
curl -s -X DELETE "https://your-pufflet/api/v1/files/$FILE_ID" -H "Authorization: Bearer $TOK"
# irreversible — deletes the Telegram copy too
curl -s -X DELETE "https://your-pufflet/api/v1/files/$FILE_ID?permanent=1" -H "Authorization: Bearer $TOK"
```

Folders work the same: `DELETE /api/v1/folders/{id}` trashes the whole subtree
with one shared timestamp; restore brings back exactly what was trashed
together. Purging a folder requires trashing first.

### Share links (public, no login)

Capability URLs — the token in the path IS the authorization. Links can carry
an expiry and are always revocable; there are no per-user ACLs (by design —
possession of the unguessable 43-char token is the permission).

```bash
# create (owner), expiring in 7 days
curl -s -X POST "https://your-pufflet/api/v1/files/$FILE_ID/share" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"expiresInDays":7}'
# → {"link":{"id":"…","urlPath":"/s/AbCdE…43-chars","createdAt":"…",
#     "expiresAt":"…","downloads":0,…},"file":{…}}

# list the file's links (includes revoked/expired for auditability)
curl -s "https://your-pufflet/api/v1/files/$FILE_ID/share" -H "Authorization: Bearer $TOK"

# revoke
curl -s -X DELETE "https://your-pufflet/api/v1/files/$FILE_ID/share?linkId=$LINK_ID" \
  -H "Authorization: Bearer $TOK"
```

Public (no auth) endpoints:

| Method | Path | Description |
|---|---|---|
| GET | `/s/{token}` | Branded download page (HTML) |
| GET | `/api/share/{token}` | Metadata: `{name, size, mimeType, createdAt, downloadPath}` — never owner data |
| GET | `/api/share/{token}/download` | Original bytes (vault-decoded); `?inline=1` for browser-safe types |

- Revoked/expired links answer `404` exactly like unknown tokens (no
  enumeration oracle). Expiry: `expiresInDays` 0–3650 (`0`/omitted = never).
- Public downloads are rate-limited per IP (30/min) and counted on the link.
- Deleting a file cascades: all of its share links die with it.
- Trashing a file also makes its links unresolvable until restore.

### Storage overview (dashboard data)

```bash
curl -s "https://your-pufflet/api/v1/…" # not exposed on /v1
# Session-only: GET /api/overview (cookie auth) returns:
# { files, bytes, folders, starred, trash, trashBytes, failedUploads,
#   byType:[{kind,files,bytes}], recent:[{action,detail,target,createdAt}],
#   activeShares, limits, telegram }
```

All numbers are EXACT sums from the metadata index. Pufflet never displays a
capacity or quota — the Bot API exposes nothing about Telegram-side storage
limits, so none is invented.

### Health

`GET /api/health` (no auth) → `{"ok":true,"checks":{"database":"up",
"databaseProvider":"sqlite|postgresql","telegramStorage":"up"}}`.

---

## Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `BAD_FILENAME` | Invalid/overlong filename (≤180 chars, no path tricks) |
| 400 | `BAD_SIZE` | Missing/invalid `size` on job creation |
| 400 | `CYCLE` | Folder move into its own subtree |
| 401 | — | Missing/invalid token, or revoked/expired key |
| 403 | — | Token lacks the required scope |
| 404 | — | Resource not found or not owned (uniform — no existence oracle) |
| 404 | `SHARE_NOT_FOUND` | Unknown/revoked/expired share token |
| 409 | `NOT_SHAREABLE` | Only ready, non-trashed files can be shared |
| 409 | — | Upload canceled / file not ready / restore-parent-first |
| 413 | `PAYLOAD_TOO_LARGE` | Upload exceeds `MAX_UPLOAD_MB` |
| 429 | — | Rate limited (login 5/5min per IP, share downloads 30/min per IP, key ops) |
| 502 | `TG_DELETE_FAILED` / `TG_DOWNLOAD` | Telegram-side failure; trash rows kept for retry |
| 503 | `TG_NOT_CONFIGURED` | Set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` |

## Key management from scripts

```bash
# create (token shown once — store it immediately)
curl -s -X POST https://your-pufflet/api/v1/keys \
  -H "Authorization: Bearer $ADMIN_TOK" -H "Content-Type: application/json" \
  -d '{"name":"backup-script","scopes":["read","write"],"expiresIn":"30d"}'
# → {"key":{…},"token":"tc_live_…","notice":"Copy this token now …"}

# revoke
curl -s -X DELETE "https://your-pufflet/api/v1/keys/$KEY_ID" \
  -H "Authorization: Bearer $ADMIN_TOK"
```

## Session endpoints (website)

`POST /api/auth/change-password` — `{currentPassword, newPassword}` (8–200
chars, must differ); throttled 10/15 min per IP; signs out all **other**
sessions. `GET /api/auth/state` — `{needsSetup, defaultUserActive, user}`.

`POST /api/trash/empty?confirm=yes` (session) — purges every trashed file AND
folder; reports `{purged, foldersPurged, failed, errors[]}`; items that fail
stay in the trash for retry.

`GET /api/backup` / `POST /api/backup/flush` / `GET /api/backup/history` /
`POST /api/backup/restore {source:"pinned"|"checkpoint", messageId?}` (session)
— status, manual snapshot, recorded recovery points, and explicit restore. The
automatic backup uploads a verified snapshot to a pinned document in the
storage chat whenever the index changes (60s cadence); a 12-hour cold
checkpoint ring keeps the previous good copies restorable, failed or empty
snapshots never replace the last good one, and restores prune dangling
references instead of failing.

## Folder tree rules

- Moving a folder into itself or its own subtree is rejected (`code:"CYCLE"`).
- Uploads/moves into a trashed folder are rejected.
- Trashing a folder trashes the whole subtree with one shared timestamp;
  restoring restores exactly what was trashed together.
