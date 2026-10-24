# Pufflet REST API (`/api/v1`)

Programmatic access to your Pufflet storage. Every request is authenticated with
an API token created in **Settings → API keys** (or via the key-management
endpoints below).

```
Authorization: Bearer tc_live_xxxxxxxxxxxxxxxx
```

- Tokens are shown **once** at creation. Only a SHA-256 hash is stored server-side.
- Scopes: `read`, `write`, `delete`, `admin`. `admin` implies everything and is
  required to manage API keys via the API.
- Errors are uniform JSON: `{"error":{"message":"…","code":"…"}}`.
- Rate limiting applies per IP on authentication attempts.

| Scope | Operations |
|---|---|
| `read` | list/get files & folders, downloads |
| `write` | create upload jobs, PUT bytes, create folders, rename/move/star/restore |
| `delete` | move to trash, permanent delete |
| `admin` | create/list/revoke API keys |

---

## Endpoint map

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/api/v1/me` | — | Who am I (user + token scopes) |
| GET | `/api/v1/files` | read | List files (`view=folder\|recent\|starred\|trash\|search`) |
| POST | `/api/v1/files` | write | Create an upload job |
| GET | `/api/v1/files/{id}` | read | File metadata |
| PATCH | `/api/v1/files/{id}` | write | Rename, move, or star |
| DELETE | `/api/v1/files/{id}` | delete | Move to trash |
| DELETE | `/api/v1/files/{id}?permanent=1` | delete | **Irreversibly** delete (Telegram message too) |
| POST | `/api/v1/files/{id}?action=restore` | write | Restore from trash |
| GET | `/api/v1/files/{id}/download` | read | Stream the file |
| GET | `/api/v1/folders` | read | List folders (`all=1` includes trashed) |
| POST | `/api/v1/folders` | write | Create folder |
| PATCH | `/api/v1/folders/{id}` | write | Rename (`{name}`) or move (`{parentId}`) |
| DELETE | `/api/v1/folders/{id}` | delete | Trash subtree |
| DELETE | `/api/v1/folders/{id}?permanent=1` | delete | Purge subtree |
| POST | `/api/v1/folders/{id}?action=restore` | write | Restore subtree |
| POST | `/api/v1/uploads` | write | Create an upload job (alias of `POST /files`) |
| GET | `/api/v1/uploads/{id}` | read | Job status: `PENDING→UPLOADING→STORING→READY/FAILED/CANCELED` |
| DELETE | `/api/v1/uploads/{id}` | write | Cancel a job |
| PUT | `/api/v1/uploads/{id}/data` | write | Send the raw bytes |
| GET | `/api/v1/keys` | admin | List API keys |
| POST | `/api/v1/keys` | admin | Create an API key |
| DELETE | `/api/v1/keys/{id}` | admin | Revoke an API key |

List parameters for `GET /files`: `view`, `folderId`, `q` (search), `sort`
(`name|size|updatedAt`), `dir` (`asc|desc`).

---

## Upload flow (two steps)

```bash
# 1) create a job
curl -s -X POST https://your-pufflet/api/v1/files \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"filename":"report.pdf","size":123456,"mimeType":"application/pdf","folderId":null}'
# → {"uploadId":"…","putTo":"/api/v1/uploads/…/data"}

# 2) PUT the raw bytes (streamed to Telegram, not buffered)
curl -s -X PUT "https://your-pufflet/api/v1/uploads/$UPLOAD_ID/data" \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @report.pdf
# → {"file":{"id":"…","name":"report.pdf","size":123456,…}}
```

The file only becomes visible (`status=READY`) after Telegram storage succeeds
and the metadata row commits. A re-PUT on the same job is idempotent; a failed
job can be retried by PUT again, or canceled with `DELETE /uploads/{id}`.

## Download

```bash
curl -sL "https://your-pufflet/api/v1/files/$FILE_ID/download" \
  -H "Authorization: Bearer $TOK" -o report.pdf
```

Streams through the server; the bot token never appears in any URL handed out.

## Folder tree rules

- Moving a folder into itself or its own subtree is rejected (`code:"CYCLE"`).
- Uploads/moves into a trashed folder are rejected.
- Trashing a folder trashes the whole subtree with one shared timestamp; restoring
  restores exactly what was trashed together.

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

Never put tokens in URLs, logs, or client-side code. Treat `tc_live_…` like a password.

## Website (session) API

The pages under `/api/*` (outside `/v1`) are for the website itself and use the
httpOnly session cookie — same services underneath, not intended for scripts.
Use `/api/v1` for programmatic access.
