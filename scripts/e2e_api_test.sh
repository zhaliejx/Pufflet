#!/usr/bin/env bash
# Pufflet end-to-end API test suite.
# Requires: dev server on :3000, telegram-mock on :3031 (see mini-services).
# Usage: bash scripts/e2e_api_test.sh
set -u
BASE="${PUFFLET_E2E_BASE:-http://localhost:3000}"
EMAIL="owner@pufflet.test"
PASS="pufflet123"
PASS_COUNT=0
FAIL_COUNT=0

say()  { printf '%s\n' "$*"; }
check() { # $1 name, $2 actual, $3 expected
  if [ "$2" = "$3" ]; then PASS_COUNT=$((PASS_COUNT+1)); say "  ok: $1"; else FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: $1 (got '$2' want '$3')"; fi
}
contains() { # $1 name, $2 haystack, $3 needle
  case "$2" in *"$3"*) PASS_COUNT=$((PASS_COUNT+1)); say "  ok: $1";; *) FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: $1 ('$3' not in '$2')";; esac
}

login() {
  curl -s -i -X POST "$BASE/api/auth/login" "${XFF[@]}" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | grep -i set-cookie | sed 's/[Ss]et-[Cc]ookie: //' | cut -d';' -f1
}

upload() { # $1 cookie, $2 filename, $3 file path -> file id (or error json)
  local job upid
  job=$(curl -s -X POST "$BASE/api/uploads" -b "$1" -H 'content-type: application/json' \
    -d "{\"filename\":\"$2\",\"size\":$(stat -c%s "$3"),\"mimeType\":\"text/plain\"}")
  upid=$(echo "$job" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
  curl -s -X PUT "$BASE/api/uploads/$upid/data" -b "$1" \
    -H 'content-type: application/octet-stream' --data-binary @"$3"
}

T=$(mktemp -d)
# Fresh per-run source IP for the in-memory rate limiters (login, key create,
# backup flush) so repeated suite runs never collide with earlier buckets.
RIP="10.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).1"
RLIP="10.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).2"
XFF=("-H" "X-Forwarded-For: $RIP")
say "== 0. seed e2e account (idempotent) =="
bun -e '
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "./src/lib/crypto";
const db = new PrismaClient();
const email = "owner@pufflet.test";
if (!(await db.user.findUnique({ where: { email } }))) {
  await db.user.create({ data: { email, passwordHash: hashPassword("pufflet123"), name: "E2E Owner", role: "OWNER" } });
  console.log("seeded");
} else {
  console.log("exists");
}
await db.$disconnect();
' >/dev/null 2>&1
check "e2e account ready" "$?" "0"

say "== 1. auth =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" "${XFF[@]}" -H 'content-type: application/json' -d '{"email":"owner@pufflet.test","password":"wrong"}')
# 401 = rejected; 429 = rejected by the brute-force limiter (e.g. failures left
# over from a previous suite run inside the 5-min window). Both are correct.
if [ "$code" = "401" ] || [ "$code" = "429" ]; then
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: login rejects bad password ($code)"
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: login rejects bad password (got '$code' want 401|429)"
fi
COOKIE=$(login)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")
check "files list requires session (401)" "$code" "401"

say "== 2. upload lifecycle =="
printf 'alpha content %s' "$RANDOM" > "$T/a.txt"
cp "$T/a.txt" "$T/b.txt"
F1=$(upload "$COOKIE" "alpha.txt" "$T/a.txt")
ID1=$(echo "$F1" | sed 's/.*"id":"\([^"]*\)".*/\1/')
contains "upload succeeds" "$F1" '"id"'
F2=$(upload "$COOKIE" "alpha.txt" "$T/b.txt")
contains "duplicate name de-duplicated" "$F2" 'alpha (2).txt'
ID2=$(echo "$F2" | sed 's/.*"id":"\([^"]*\)".*/\1/')

say "== 3. rename / star / search =="
R=$(curl -s -X PATCH "$BASE/api/files/$ID1" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"renamed-note.txt"}')
contains "rename works" "$R" 'renamed-note.txt'
S=$(curl -s -X PATCH "$BASE/api/files/$ID1" -b "$COOKIE" -H 'content-type: application/json' -d '{"starred":true}')
contains "star works" "$S" '"starred":true'
ST=$(curl -s "$BASE/api/files?view=starred" -b "$COOKIE")
contains "starred view lists it" "$ST" 'renamed-note.txt'
SQ=$(curl -s "$BASE/api/files?view=search&q=renamed" -b "$COOKIE")
contains "search finds it" "$SQ" 'renamed-note.txt'
SQ2=$(curl -s "$BASE/api/files?view=search&q=zzznotfound" -b "$COOKIE")
contains "search misses cleanly" "$SQ2" '"files":[]'

say "== 4. download roundtrip =="
curl -s -o "$T/dl.txt" "$BASE/api/files/$ID1/download" -b "$COOKIE"
if diff -q "$T/a.txt" "$T/dl.txt" >/dev/null; then PASS_COUNT=$((PASS_COUNT+1)); say "  ok: bytes identical"; else FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: download differs"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files/$ID1/download")
check "download requires auth" "$code" "401"

say "== 5. folders + circular guard =="
FO=$(curl -s -X POST "$BASE/api/folders" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"Projects"}')
FOID=$(echo "$FO" | sed 's/.*"id":"\([^"]*\)".*/\1/')
SUB=$(curl -s -X POST "$BASE/api/folders" -b "$COOKIE" -H 'content-type: application/json' -d "{\"name\":\"Sub\",\"parentId\":\"$FOID\"}")
SUBID=$(echo "$SUB" | sed 's/.*"id":"\([^"]*\)".*/\1/')
M=$(curl -s -X PATCH "$BASE/api/folders/$FOID" -b "$COOKIE" -H 'content-type: application/json' -d "{\"parentId\":\"$SUBID\"}")
contains "circular move rejected" "$M" 'CYCLE'
MV=$(curl -s -X PATCH "$BASE/api/files/$ID2" -b "$COOKIE" -H 'content-type: application/json' -d "{\"folderId\":\"$SUBID\"}")
contains "move file into subfolder" "$MV" "\"folderId\":\"$SUBID\""

say "== 6. trash / restore / purge =="
curl -s -X DELETE "$BASE/api/files/$ID1" -b "$COOKIE" >/dev/null
TR=$(curl -s "$BASE/api/files?view=trash" -b "$COOKIE")
contains "trashed file in trash view" "$TR" 'renamed-note.txt'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/files/$ID1/restore" -b "$COOKIE")
check "restore returns 200" "$code" "200"
curl -s -X DELETE "$BASE/api/files/$ID1" -b "$COOKIE" >/dev/null
P=$(curl -s -X DELETE "$BASE/api/files/$ID1?permanent=1" -b "$COOKIE")
contains "purge ok" "$P" '"purged":true'
G=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files/$ID1" -b "$COOKIE")
check "purged file gone (404)" "$G" "404"
# folder subtree trash/restore
TRF=$(curl -s -X DELETE "$BASE/api/folders/$FOID" -b "$COOKIE")
contains "folder trash reports subtree" "$TRF" '"files":'
RS=$(curl -s -X POST "$BASE/api/folders/$FOID?action=restore" -b "$COOKIE")
contains "folder restore" "$RS" '"ok":true'

say "== 7. API tokens (v1) =="
K=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" "${XFF[@]}" -H 'content-type: application/json' -d '{"name":"test-suite","scopes":["read","write","delete"]}')
TOK=$(echo "$K" | sed 's/.*"token":"\([^"]*\)".*/\1/')
contains "token returned once with prefix" "$TOK" 'tc_live_'
KLIST=$(curl -s "$BASE/api/keys" -b "$COOKIE")
if echo "$KLIST" | grep -q "$TOK"; then FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: raw token stored/returned"; else PASS_COUNT=$((PASS_COUNT+1)); say "  ok: raw token never listed again"; fi
ME=$(curl -s "$BASE/api/v1/me" -H "Authorization: Bearer $TOK")
contains "v1 me works" "$ME" '"scopes"'
V1L=$(curl -s "$BASE/api/v1/files" -H "Authorization: Bearer $TOK")
contains "v1 list works" "$V1L" '"files"'
printf 'api upload %s' "$RANDOM" > "$T/api.txt"
APIF="api-file-$RANDOM.txt"
V1J=$(curl -s -X POST "$BASE/api/v1/files" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d "{\"filename\":\"$APIF\",\"size\":$(stat -c%s "$T/api.txt")}")
V1UP=$(echo "$V1J" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
V1F=$(curl -s -X PUT "$BASE/api/v1/uploads/$V1UP/data" -H "Authorization: Bearer $TOK" -H 'content-type: application/octet-stream' --data-binary @"$T/api.txt")
contains "v1 upload works" "$V1F" "\"name\":\"$APIF\""
# read-only key cannot write
KR=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" "${XFF[@]}" -H 'content-type: application/json' -d '{"name":"readonly","scopes":["read"]}')
TOKR=$(echo "$KR" | sed 's/.*"token":"\([^"]*\)".*/\1/')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/files" -H "Authorization: Bearer $TOKR" -H 'content-type: application/json' -d '{"filename":"x.txt","size":3}')
check "read-only key cannot upload (403)" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/files" -H "Authorization: Bearer bogus")
check "bogus token rejected (401)" "$code" "401"
# revoke kills access
KID=$(echo "$KR" | sed 's/.*"key":{"id":"\([^"]*\)".*/\1/')
curl -s -X DELETE "$BASE/api/keys/$KID" -b "$COOKIE" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/files" -H "Authorization: Bearer $TOKR")
check "revoked key rejected (401)" "$code" "401"

say "== 8. input validation =="
BAD=$(curl -s -X POST "$BASE/api/uploads" -b "$COOKIE" -H 'content-type: application/json' -d '{"filename":"../evil.txt","size":10}')
contains "path traversal filename rejected" "$BAD" 'Invalid filename'
LONG=$(python3 -c "print('x'*300)")
BAD2=$(curl -s -X POST "$BASE/api/uploads" -b "$COOKIE" -H 'content-type: application/json' -d "{\"filename\":\"$LONG\",\"size\":10}")
contains "overlong filename rejected" "$BAD2" 'Invalid filename'

say "== 9. login rate limit =="
LAST=000
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  LAST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "X-Forwarded-For: $RLIP" -H 'content-type: application/json' -d '{"email":"ratelimit@x.test","password":"nope"}')
done
check "repeated failures rate-limited (429)" "$LAST" "429"

say "== 10. state backup =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/backup")
check "backup status requires session (401)" "$code" "401"
FLUSH=$(curl -s -X POST "$BASE/api/backup/flush" -b "$COOKIE" "${XFF[@]}")
contains "manual flush succeeds" "$FLUSH" '"ok":true'
STATUS=$(curl -s "$BASE/api/backup" -b "$COOKIE")
contains "status shows last backup time" "$STATUS" '"lastBackupAt":"2'
contains "status reports snapshot size" "$STATUS" '"lastBackupSize":'
# flush again -> must REUSE the same pinned message via editMessageMedia (no chat spam)
FLUSH2=$(curl -s -X POST "$BASE/api/backup/flush" -b "$COOKIE" "${XFF[@]}")
contains "second flush edits in place" "$FLUSH2" '"ok":true'
# the pinned snapshot must be discoverable via getChat on the mock
PIN=$(curl -s "http://localhost:3031/bot123456:ABC-mock-local/getChat")
contains "mock chat has pinned snapshot" "$PIN" 'pufflet-state-backup.json'

say "== 11. public share links (no login) =="
SH=$(curl -s -X POST "$BASE/api/files/$ID2/share" -b "$COOKIE" -H 'content-type: application/json' -d '{}')
contains "share link created" "$SH" '"urlPath":"/s/'
TOKS=$(echo "$SH" | sed 's/.*"urlPath":"\/s\/\([^"]*\)".*/\1/')
SLID=$(echo "$SH" | sed 's/.*"link":{"id":"\([^"]*\)".*/\1/')
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/$TOKS")
check "public share page renders without login (200)" "$code" "200"
META=$(curl -s "$BASE/api/share/$TOKS")
contains "public meta exposes file name" "$META" '"name"'
if echo "$META" | grep -q 'ownerId\|"email"\|passwordHash'; then
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: public meta leaks owner data"
else
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: public meta hides owner data"
fi
curl -s -o "$T/sdl.txt" "$BASE/api/share/$TOKS/download"
if diff -q "$T/b.txt" "$T/sdl.txt" >/dev/null; then PASS_COUNT=$((PASS_COUNT+1)); say "  ok: share download bytes identical (no login)"; else FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: share download differs"; fi
SHLIST=$(curl -s "$BASE/api/files/$ID2/share" -b "$COOKIE")
contains "download counter incremented" "$SHLIST" '"downloads":1'
SH404=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files/$ID2/share")
check "share management requires session (401)" "$SH404" "401"
REV=$(curl -s -X DELETE "$BASE/api/files/$ID2/share?linkId=$SLID" -b "$COOKIE")
contains "revoke works" "$REV" '"ok":true'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/share/$TOKS/download")
check "revoked link rejected (404)" "$code" "404"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/share/bogus-token-xyz")
check "bogus token rejected (404)" "$code" "404"
# v1 mirror: create + list with the API token from section 7
V1SH=$(curl -s -X POST "$BASE/api/v1/files/$ID2/share" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{}')
contains "v1 share create works" "$V1SH" '"urlPath":"/s/'
V1SLID=$(echo "$V1SH" | sed 's/.*"link":{"id":"\([^"]*\)".*/\1/')
curl -s -X DELETE "$BASE/api/v1/files/$ID2/share?linkId=$V1SLID" -H "Authorization: Bearer $TOK" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/files/$ID2/share" -H "Authorization: Bearer $TOKR" -H 'content-type: application/json' -d '{}')
check "revoked read-only key cannot share (401)" "$code" "401"

say "== 12. listing performance contract (metadata-only + pagination) =="
PL=$(curl -s "$BASE/api/files?view=folder&limit=1" -b "$COOKIE")
contains "limit=1 returns exactly one file" "$PL" '"total"'
N1=$(echo "$PL" | grep -o '"id"' | wc -l)
# one file object = 1 "id" occurrence (folders list absent from /api/files)
check "limit param honored" "$N1" "1"
if echo "$PL" | grep -q 'tgFileId\|tgChatId\|tgMessageId'; then
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: listing leaks Telegram storage refs"
else
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: listings carry metadata only (no tg* refs)"
fi
P2=$(curl -s "$BASE/api/files?view=folder&limit=1&offset=1" -b "$COOKIE")
contains "offset paginates (total still present)" "$P2" '"total"'
NS=$(curl -s "$BASE/api/files?view=search&q=zzznone" -b "$COOKIE")
contains "search empty has total field" "$NS" '"total":0'

say "== 13. bulk operations =="
printf 'bulk a %s' "$RANDOM" > "$T/ba.txt"
printf 'bulk b %s' "$RANDOM" > "$T/bb.txt"
BA=$(upload "$COOKIE" "bulk-a.txt" "$T/ba.txt"); BAID=$(echo "$BA" | sed 's/.*"id":"\([^"]*\)".*/\1/')
BB=$(upload "$COOKIE" "bulk-b.txt" "$T/bb.txt"); BBID=$(echo "$BB" | sed 's/.*"id":"\([^"]*\)".*/\1/')
FB=$(curl -s -X POST "$BASE/api/folders" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"BulkTarget"}')
FBID=$(echo "$FB" | sed 's/.*"id":"\([^"]*\)".*/\1/')
BT=$(curl -s -X POST "$BASE/api/files/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"trash\",\"ids\":[\"$BAID\",\"$BBID\"]}")
contains "bulk trash succeeds" "$BT" '"succeeded":2'
BTR=$(curl -s "$BASE/api/files?view=trash" -b "$COOKIE")
contains "bulk-trashed files visible in trash" "$BTR" 'bulk-a.txt'
BR=$(curl -s -X POST "$BASE/api/files/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"restore\",\"ids\":[\"$BAID\",\"$BBID\"]}")
contains "bulk restore succeeds" "$BR" '"succeeded":2'
BS=$(curl -s -X POST "$BASE/api/files/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"star\",\"ids\":[\"$BAID\"]}")
contains "bulk star succeeds" "$BS" '"succeeded":1'
BM=$(curl -s -X POST "$BASE/api/files/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"move\",\"ids\":[\"$BAID\",\"$BBID\"],\"folderId\":\"$FBID\"}")
contains "bulk move succeeds" "$BM" '"succeeded":2'
IN=$(curl -s "$BASE/api/files/$BAID" -b "$COOKIE")
contains "moved file landed in target folder" "$IN" "\"folderId\":\"$FBID\""
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/files/bulk" -b "$COOKIE" -H 'content-type: application/json' -d '{"action":"explode","ids":[]}')
check "invalid bulk action rejected (400)" "$BAD" "400"

say "== 14. folder bulk + trash shows folders =="
FT=$(curl -s -X POST "$BASE/api/folders/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"trash\",\"ids\":[\"$FBID\"]}")
contains "folder bulk trash succeeds" "$FT" '"succeeded":1'
FLD=$(curl -s "$BASE/api/folders?all=1" -b "$COOKIE")
contains "trashed folder visible with trashedAt" "$FLD" '"trashedAt"'
FR=$(curl -s -X POST "$BASE/api/folders/bulk" -b "$COOKIE" -H 'content-type: application/json' -d "{\"action\":\"restore\",\"ids\":[\"$FBID\"]}")
contains "folder bulk restore succeeds" "$FR" '"succeeded":1'
IN2=$(curl -s "$BASE/api/files/$BAID" -b "$COOKIE")
contains "subtree restore brought file back" "$IN2" '"id"'

say "== 15. dashboard overview + share management =="
OV=$(curl -s "$BASE/api/overview" -b "$COOKIE")
contains "overview has byType breakdown" "$OV" '"byType"'
contains "overview has recent activity" "$OV" '"recent"'
contains "overview has active share count" "$OV" '"activeShares"'
if echo "$OV" | grep -q 'capacity\|quota'; then
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: overview invents capacity data"
else
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: overview never invents capacity"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/overview")
check "overview requires session (401)" "$code" "401"
SHX=$(curl -s -X POST "$BASE/api/files/$BAID/share" -b "$COOKIE" -H 'content-type: application/json' -d '{"expiresInDays":7}')
contains "share with expiry created" "$SHX" '"expiresAt"'
SHXLID=$(echo "$SHX" | sed 's/.*"link":{"id":"\([^"]*\)".*/\1/')
ALLSH=$(curl -s "$BASE/api/shares" -b "$COOKIE")
contains "shares endpoint lists the link" "$ALLSH" 'bulk-a.txt'
contains "shares endpoint shows expiry" "$ALLSH" '"expiresAt"'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/shares")
check "shares endpoint requires session (401)" "$code" "401"
curl -s -X DELETE "$BASE/api/files/$BAID/share?linkId=$SHXLID" -b "$COOKIE" >/dev/null
ALLSH2=$(curl -s "$BASE/api/shares" -b "$COOKIE")
if echo "$ALLSH2" | grep -q "$SHXLID"; then
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: revoked link still listed"
else
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: revoked link disappears from management list"
fi

say "== 16. empty trash includes folders =="
ETD=$(curl -s -X POST "$BASE/api/folders" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"DoomedFolder"}')
ETDID=$(echo "$ETD" | sed 's/.*"id":"\([^"]*\)".*/\1/')
printf 'doomed %s' "$RANDOM" > "$T/d.txt"
DF=$(upload "$COOKIE" "doomed.txt" "$T/d.txt"); DFID=$(echo "$DF" | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -X PATCH "$BASE/api/files/$DFID" -b "$COOKIE" -H 'content-type: application/json' -d "{\"folderId\":\"$ETDID\"}" >/dev/null
curl -s -X DELETE "$BASE/api/folders/$ETDID" -b "$COOKIE" >/dev/null
ET=$(curl -s -X POST "$BASE/api/trash/empty?confirm=yes" -b "$COOKIE")
contains "empty trash reports folder purge" "$ET" '"foldersPurged"'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files/$DFID" -b "$COOKIE")
check "folder purge removed inner file (404)" "$code" "404"

say "== 17. Google Drive remote import (fake Drive on the mock) =="
# The server must run with PUFFLET_GDRIVE_BASE=http://127.0.0.1:3031/fake-gdrive
# Deterministic re-runs: drop stale imports (incl. "... (2)" dedup leftovers)
# from earlier suite runs so name checks stay exact.
bun -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const user = await db.user.findUnique({ where: { email: "owner@pufflet.test" } });
if (user) await db.file.deleteMany({ where: { ownerId: user.id, OR: [{ name: { startsWith: "from-drive" } }, { name: "scanned.bin" }] } });
await db.$disconnect();
' >/dev/null 2>&1
GDURL="https://drive.google.com/file/d/e2e_gd_pub/view?usp=sharing"
printf 'gdrive payload %s' "$RANDOM" > "$T/gd.txt"
curl -s -X POST "http://localhost:3031/fake-gdrive/_seed?id=e2e_gd_pub&name=from-drive.txt&mime=text/plain" --data-binary @"$T/gd.txt" >/dev/null
GDPROBE=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d "{\"url\":\"$GDURL\",\"probe\":true}")
contains "probe resolves filename" "$GDPROBE" 'from-drive.txt'
contains "probe resolves size" "$GDPROBE" "\"size\":$(stat -c%s "$T/gd.txt")"
GDBAD=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d '{"url":"https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv"}')
contains "folder link rejected with guidance" "$GDBAD" 'FOLDER'
GDBOGUS=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d '{"url":"https://evil.example.com/file/d/1a2B3c4D5e6F7g8H9i0J/view"}')
contains "non-Drive host rejected" "$GDBOGUS" 'evil.example.com'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/uploads/remote" -H 'content-type: application/json' -d '{"url":"https://drive.google.com/file/d/e2e_gd_pub/view"}')
check "remote import requires session (401)" "$code" "401"
curl -s -X POST "http://localhost:3031/fake-gdrive/_seed?id=e2e_gd_priv&name=secret.txt&mime=text/plain&mode=private" --data-binary @"$T/gd.txt" >/dev/null
GDPRIV=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d '{"url":"https://drive.google.com/file/d/e2e_gd_priv/view"}')
contains "private file rejected with fix-it message" "$GDPRIV" 'Anyone with the link'
# real import (plain) — poll the job row like the web client does
GDIMP=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d '{"url":"https://drive.google.com/uc?id=e2e_gd_pub","folderId":null}')
contains "import accepted" "$GDIMP" '"uploadId"'
GUPID=$(echo "$GDIMP" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
GDSTATUS=""
for i in $(seq 1 20); do
  GDJ=$(curl -s "$BASE/api/uploads/$GUPID" -b "$COOKIE")
  GDSTATUS=$(echo "$GDJ" | sed 's/.*"status":"\([A-Z_]*\)".*/\1/')
  [ "$GDSTATUS" = "READY" ] || [ "$GDSTATUS" = "FAILED" ] && break
  sleep 1
done
check "import completes READY" "$GDSTATUS" "READY"
if [ "$GDSTATUS" = "READY" ]; then
  GDFILE=$(curl -s "$BASE/api/uploads/$GUPID" -b "$COOKIE" | sed 's/.*"fileId":"\([^"]*\)".*/\1/')
  contains "imported file named from Drive" "$(curl -s "$BASE/api/files/$GDFILE" -b "$COOKIE")" 'from-drive.txt'
  curl -s "$BASE/api/files/$GDFILE/download" -b "$COOKIE" -o "$T/gd-out.txt"
  if cmp -s "$T/gd.txt" "$T/gd-out.txt"; then PASS_COUNT=$((PASS_COUNT+1)); say "  ok: imported bytes identical (Drive -> Telegram -> download)"; else FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: imported bytes differ"; fi
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: import job did not reach READY (got $GDSTATUS)"
fi
# scan-warning interstitial must be followed automatically (confirm form)
curl -s -X POST "http://localhost:3031/fake-gdrive/_seed?id=e2e_gd_scan&name=scanned.bin&mime=application/octet-stream&mode=scan" --data-binary @"$T/gd.txt" >/dev/null
GDIMP2=$(curl -s -X POST "$BASE/api/uploads/remote" -b "$COOKIE" -H 'content-type: application/json' -d '{"url":"https://drive.usercontent.google.com/download?id=e2e_gd_scan&export=download"}')
contains "scan-page import accepted" "$GDIMP2" '"uploadId"'
GUPID2=$(echo "$GDIMP2" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
GDSTATUS2=""
for i in $(seq 1 20); do
  GDSTATUS2=$(curl -s "$BASE/api/uploads/$GUPID2" -b "$COOKIE" | sed 's/.*"status":"\([A-Z_]*\)".*/\1/')
  [ "$GDSTATUS2" = "READY" ] || [ "$GDSTATUS2" = "FAILED" ] && break
  sleep 1
done
check "scan-warning import completes READY" "$GDSTATUS2" "READY"
if [ "$GDSTATUS2" = "READY" ]; then
  contains "scan-page file kept Drive name" "$(curl -s "$BASE/api/uploads/$GUPID2" -b "$COOKIE")" 'scanned.bin'
fi
# cleanup: purge the fresh imports so repeated runs never hit dedup renames
GDFILE2=$(curl -s "$BASE/api/uploads/$GUPID2" -b "$COOKIE" | sed 's/.*"fileId":"\([^"]*\)".*/\1/')
curl -s -X DELETE "$BASE/api/files/$GDFILE?permanent=1" -b "$COOKIE" >/dev/null
curl -s -X DELETE "$BASE/api/files/$GDFILE2?permanent=1" -b "$COOKIE" >/dev/null

say "== 18. Folder upload (ensure-paths + nested upload) =="
# Deterministic re-runs: drop any e2e_up_* tree left by an earlier crashed run.
bun -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const user = await db.user.findUnique({ where: { email: "owner@pufflet.test" } });
if (user) {
  const all = await db.folder.findMany({ where: { ownerId: user.id }, select: { id: true, parentId: true } });
  const roots = await db.folder.findMany({ where: { ownerId: user.id, name: { in: ["e2e_up_a", "e2e_up_b"] } }, select: { id: true } });
  const childrenOf = new Map<string, string[]>();
  for (const f of all) if (f.parentId) childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);
  const doomed = new Set<string>(roots.map((r) => r.id));
  const queue = [...doomed];
  while (queue.length) {
    for (const c of childrenOf.get(queue.shift() as string) ?? []) if (!doomed.has(c)) { doomed.add(c); queue.push(c); }
  }
  await db.file.deleteMany({ where: { ownerId: user.id, folderId: { in: [...doomed] } } });
  await db.folder.deleteMany({ where: { id: { in: [...doomed] } } });
}
await db.$disconnect();
' >/dev/null 2>&1
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/folders/ensure-paths" -H 'content-type: application/json' -d '{"paths":["x"]}')
check "ensure-paths requires session (401)" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/folders/ensure-paths" -H 'content-type: application/json' -d '{"paths":["x"]}')
check "v1 ensure-paths requires token (401)" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{}')
check "ensure-paths without paths rejected (400)" "$code" "400"
# build a tree in one round trip
E1=$(curl -s -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{"paths":["e2e_up_a","e2e_up_a/sub","e2e_up_b"]}')
contains "ensure-paths returns folder ids" "$E1" '"e2e_up_a/sub":"'
EAID=$(echo "$E1" | sed 's/.*"e2e_up_a":"\([^"]*\)".*/\1/')
ESUBID=$(echo "$E1" | sed 's/.*"e2e_up_a\/sub":"\([^"]*\)".*/\1/')
EBID=$(echo "$E1" | sed 's/.*"e2e_up_b":"\([^"]*\)".*/\1/')
# second call reuses the SAME folders (find-or-create, not duplicates)
E2=$(curl -s -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{"paths":["e2e_up_a","e2e_up_a/sub","e2e_up_b"]}')
check "ensure-paths reuses existing folders" "$(echo "$E2" | sed 's/.*"e2e_up_a\/sub":"\([^"]*\)".*/\1/')" "$ESUBID"
contains "reuse reports zero created" "$E2" '"created":0'
# invalid segment lands in errors; valid paths still resolve
E3=$(curl -s -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{"paths":["..","e2e_up_b"]}')
contains "invalid path reported with reason" "$E3" 'Invalid folder name'
check "valid path resolved alongside invalid" "$(echo "$E3" | sed 's/.*"e2e_up_b":"\([^"]*\)".*/\1/')" "$EBID"
# upload INTO the created nested folder
printf 'nested folder payload %s' "$RANDOM" > "$T/nested.txt"
NJOB=$(curl -s -X POST "$BASE/api/uploads" -b "$COOKIE" -H 'content-type: application/json' -d "{\"filename\":\"e2e_nested.txt\",\"size\":$(stat -c%s "$T/nested.txt"),\"folderId\":\"$ESUBID\"}")
NUP=$(echo "$NJOB" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
curl -s -X PUT "$BASE/api/uploads/$NUP/data" -b "$COOKIE" -H 'content-type: application/octet-stream' --data-binary @"$T/nested.txt" >/dev/null
contains "nested file listed inside created folder" "$(curl -s "$BASE/api/files?view=folder&folderId=$ESUBID" -b "$COOKIE")" 'e2e_nested.txt'
# v1 mirror works with an API key, under an existing parent
V1E=$(curl -s -X POST "$BASE/api/v1/folders/ensure-paths" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d "{\"parentId\":\"$EBID\",\"paths\":[\"inner\"]}")
contains "v1 ensure-paths creates under parent" "$V1E" '"inner":"'
# cleanup: trash then permanent-delete both roots (purges nested content too)
curl -s -X DELETE "$BASE/api/folders/$EAID" -b "$COOKIE" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/folders/$EAID?permanent=1" -b "$COOKIE")
check "cleanup: purge e2e_up_a" "$code" "200"
curl -s -X DELETE "$BASE/api/folders/$EBID" -b "$COOKIE" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/folders/$EBID?permanent=1" -b "$COOKIE")
check "cleanup: purge e2e_up_b" "$code" "200"

say "== 19. rclone storage integration (mock binary) =="
# Requires the server to run with PUFFLET_RCLONE_PATH=<repo>/scripts/rclone-mock.mjs
# and RCLONE_MOCK_STATE pointing at a scratch directory. The mock materializes
# uploads/downloads as plain files, so every round trip can be byte-compared.
if [ "${PUFFLET_RCLONE_E2E:-}" != "1" ] || [ ! -x "${PUFFLET_RCLONE_PATH:-}" ]; then
  say "  skip: start the server with PUFFLET_RCLONE_PATH=scripts/rclone-mock.mjs and PUFFLET_RCLONE_E2E=1 to run this section"
else
  RCSTATE="${RCLONE_MOCK_STATE:?RCLONE_MOCK_STATE must point at the mock state dir}"
  rm -rf "$RCSTATE"
  mkdir -p "$RCSTATE"

  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/rclone/remotes")
  check "rclone remotes require session (401)" "$code" "401"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rclone/remotes" -H 'content-type: application/json' -d '{"name":"x","type":"local"}')
  check "rclone remote create requires session (401)" "$code" "401"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/rclone/remotes")
  check "v1 rclone remotes require token (401)" "$code" "401"

  ST=$(curl -s "$BASE/api/rclone/status" -b "$COOKIE")
  contains "rclone binary detected (mock version)" "$ST" 'v1.99.0-mock'

  CR=$(curl -s -X POST "$BASE/api/rclone/remotes" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"e2e-remote","type":"local","config":{}}')
  contains "remote created" "$CR" '"name":"e2e-remote"'
  RID=$(echo "$CR" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rclone/remotes" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"e2e-remote","type":"local","config":{}}')
  check "duplicate remote name rejected (409)" "$code" "409"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rclone/remotes" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"Bad_Name","type":"local","config":{}}')
  check "invalid remote name rejected (400)" "$code" "400"

  TT=$(curl -s -X POST "$BASE/api/rclone/remotes/$RID/test" -b "$COOKIE")
  contains "connectivity test passes" "$TT" '"ok":true'
  BR=$(curl -s "$BASE/api/rclone/remotes/$RID/browse?path=" -b "$COOKIE")
  contains "empty remote lists zero entries" "$BR" '"entries":[]'

  # send: Pufflet -> remote (rcat), byte-compared against the mock state dir
  printf 'rclone e2e payload %s' "$RANDOM" > "$T/rc-src.txt"
  RCF=$(upload "$COOKIE" "rc-src.txt" "$T/rc-src.txt")
  RCFID=$(echo "$RCF" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  SND=$(curl -s --max-time 60 -X POST "$BASE/api/rclone/remotes/$RID/send" -b "$COOKIE" -H 'content-type: application/json' -d "{\"fileId\":\"$RCFID\",\"targetPath\":\"e2e_rclone/hello.txt\"}")
  contains "send streams file to remote path" "$SND" '"path":"e2e_rclone/hello.txt"'
  if diff -q "$T/rc-src.txt" "$RCSTATE/e2e_rclone/hello.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: rcat bytes identical on the remote"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: rcat bytes differ on the remote"
  fi
  BR2=$(curl -s "$BASE/api/rclone/remotes/$RID/browse?path=e2e_rclone" -b "$COOKIE")
  contains "browse shows the sent file with its size" "$BR2" '"name":"hello.txt"'

  # download: remote -> browser proxy stream, byte-compared
  curl -s --max-time 60 -o "$T/rc-dl.txt" "$BASE/api/rclone/remotes/$RID/download?path=e2e_rclone%2Fhello.txt" -b "$COOKIE"
  if diff -q "$T/rc-src.txt" "$T/rc-dl.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: remote download bytes identical"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: remote download bytes differ"
  fi

  # ingest: remote -> Pufflet (full round trip back through the vault)
  ING=$(curl -s --max-time 60 -X POST "$BASE/api/rclone/remotes/$RID/ingest" -b "$COOKIE" -H 'content-type: application/json' -d '{"path":"e2e_rclone/hello.txt"}')
  contains "ingest returns the created file" "$ING" '"fileId":"'
  INGID=$(echo "$ING" | sed 's/.*"fileId":"\([^"]*\)".*/\1/')
  curl -s -o "$T/rc-rt.txt" "$BASE/api/files/$INGID/download" -b "$COOKIE"
  if diff -q "$T/rc-src.txt" "$T/rc-rt.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: full Pufflet->remote->Pufflet round trip is byte-perfect"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: ingest round trip bytes differ"
  fi

  # secrets never come back
  SEC="s3cr3t-$RANDOM-$RANDOM"
  SR=$(curl -s -X POST "$BASE/api/rclone/remotes" -b "$COOKIE" -H 'content-type: application/json' -d "{\"name\":\"e2e-secret\",\"type\":\"s3\",\"config\":{\"region\":\"eu-west-1\",\"access_key_id\":\"AKIAE2E\",\"secret_access_key\":\"$SEC\"}}")
  contains "s3 remote created" "$SR" '"name":"e2e-secret"'
  SRID=$(echo "$SR" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  ALLR=$(curl -s "$BASE/api/rclone/remotes" -b "$COOKIE")
  ALLR2=$(curl -s "$BASE/api/v1/rclone/remotes" -H "Authorization: Bearer $TOK")
  if echo "$ALLR$ALLR2" | grep -q "$SEC"; then
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: secret value leaked in a listing response"
  else
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: secret value absent from every listing"
  fi
  SRUP=$(curl -s -X PATCH "$BASE/api/rclone/remotes/$SRID" -b "$COOKIE" -H 'content-type: application/json' -d '{"config":{"secret_access_key":""}}')
  contains "empty secret on update keeps stored value (no error)" "$SRUP" '"name":"e2e-secret"'
  curl -s -X DELETE "$BASE/api/rclone/remotes/$SRID" -b "$COOKIE" >/dev/null

  # folder sync push: Pufflet tree -> remote
  ES=$(curl -s -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{"paths":["rclone_sync_src","rclone_sync_src/sub"]}')
  SRCID=$(echo "$ES" | sed 's/.*"rclone_sync_src":"\([^"]*\)".*/\1/')
  printf 'sync file A %s' "$RANDOM" > "$T/sync-a.txt"
  printf 'sync file B %s' "$RANDOM" > "$T/sync-b.txt"
  SA=$(upload "$COOKIE" "sync-a.txt" "$T/sync-a.txt"); SAID=$(echo "$SA" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  curl -s -X PATCH "$BASE/api/files/$SAID" -b "$COOKIE" -H 'content-type: application/json' -d "{\"folderId\":\"$SRCID\"}" >/dev/null
  SB=$(upload "$COOKIE" "sync-b.txt" "$T/sync-b.txt"); SBID=$(echo "$SB" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  SUBID=$(echo "$ES" | sed 's/.*"rclone_sync_src\/sub":"\([^"]*\)".*/\1/')
  curl -s -X PATCH "$BASE/api/files/$SBID" -b "$COOKIE" -H 'content-type: application/json' -d "{\"folderId\":\"$SUBID\"}" >/dev/null
  PJ=$(curl -s -X POST "$BASE/api/rclone/sync" -b "$COOKIE" -H 'content-type: application/json' -d "{\"remoteId\":\"$RID\",\"kind\":\"push\",\"remotePath\":\"sync-target\",\"folderId\":\"$SRCID\"}")
  contains "push job queued" "$PJ" '"status":"QUEUED"'
  PJID=$(echo "$PJ" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  PSTAT="QUEUED"
  for _ in $(seq 1 40); do
    PSTAT=$(curl -s "$BASE/api/rclone/jobs/$PJID" -b "$COOKIE" | sed 's/.*"status":"\([A-Z]*\)".*/\1/')
    case "$PSTAT" in QUEUED|RUNNING) sleep 0.5;; *) break;; esac
  done
  check "push job finished" "$PSTAT" "DONE"
  if diff -q "$T/sync-a.txt" "$RCSTATE/sync-target/sync-a.txt" >/dev/null 2>&1 && diff -q "$T/sync-b.txt" "$RCSTATE/sync-target/sub/sync-b.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: push mirrored the folder structure byte-perfect"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: push output missing or differs"
  fi

  # folder sync pull: remote -> a fresh Pufflet folder
  ED=$(curl -s -X POST "$BASE/api/folders/ensure-paths" -b "$COOKIE" -H 'content-type: application/json' -d '{"paths":["rclone_sync_dst"]}')
  DSTID=$(echo "$ED" | sed 's/.*"rclone_sync_dst":"\([^"]*\)".*/\1/')
  LJ=$(curl -s -X POST "$BASE/api/rclone/sync" -b "$COOKIE" -H 'content-type: application/json' -d "{\"remoteId\":\"$RID\",\"kind\":\"pull\",\"remotePath\":\"sync-target\",\"folderId\":\"$DSTID\"}")
  LJID=$(echo "$LJ" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  LSTAT="QUEUED"
  for _ in $(seq 1 40); do
    LSTAT=$(curl -s "$BASE/api/rclone/jobs/$LJID" -b "$COOKIE" | sed 's/.*"status":"\([A-Z]*\)".*/\1/')
    case "$LSTAT" in QUEUED|RUNNING) sleep 0.5;; *) break;; esac
  done
  check "pull job finished" "$LSTAT" "DONE"
  SUB2=$(curl -s "$BASE/api/folders?all=1" -b "$COOKIE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(f['id'] for f in d['folders'] if f['name']=='sub' and f['parentId']=='$DSTID'))" 2>/dev/null)
  if [ -n "$SUB2" ]; then
    contains "pull imported the nested file" "$(curl -s "$BASE/api/files?view=folder&folderId=$SUB2" -b "$COOKIE")" 'sync-b.txt'
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: pull did not mirror the sub folder"
  fi

  # v1 scope enforcement + admin-scope mirror
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/rclone/remotes" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"name":"v1-remote","type":"local","config":{}}')
  check "v1 remote create requires admin scope (403)" "$code" "403"
  AK=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" "${XFF[@]}" -H 'content-type: application/json' -d '{"name":"rclone-admin","scopes":["admin"]}')
  ATOK=$(echo "$AK" | sed 's/.*"token":"\([^"]*\)".*/\1/')
  V1C=$(curl -s -X POST "$BASE/api/v1/rclone/remotes" -H "Authorization: Bearer $ATOK" -H 'content-type: application/json' -d '{"name":"v1-remote","type":"local","config":{}}')
  contains "v1 remote create with admin scope works" "$V1C" '"name":"v1-remote"'
  V1RID=$(echo "$V1C" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v1/rclone/remotes/$V1RID" -H "Authorization: Bearer $ATOK")
  check "v1 remote delete with admin scope works (200)" "$code" "200"
  curl -s -X DELETE "$BASE/api/keys/$(echo "$AK" | sed 's/.*"id":"\([^"]*\)".*/\1/')" -b "$COOKIE" >/dev/null

  # delete remote: 404 afterwards
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/rclone/remotes/$RID" -b "$COOKIE")
  check "remote deleted (200)" "$code" "200"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/rclone/remotes/$RID/browse?path=" -b "$COOKIE")
  check "browse after delete is 404" "$code" "404"

  # cleanup: purge sync folders + mock state
  curl -s -X DELETE "$BASE/api/folders/$SRCID" -b "$COOKIE" >/dev/null
  curl -s -X DELETE "$BASE/api/folders/$SRCID?permanent=1" -b "$COOKIE" >/dev/null
  curl -s -X DELETE "$BASE/api/folders/$DSTID" -b "$COOKIE" >/dev/null
  curl -s -X DELETE "$BASE/api/folders/$DSTID?permanent=1" -b "$COOKIE" >/dev/null
  curl -s -X DELETE "$BASE/api/files/$RCFID?permanent=1" -b "$COOKIE" >/dev/null
  curl -s -X DELETE "$BASE/api/files/$INGID?permanent=1" -b "$COOKIE" >/dev/null
  rm -rf "$RCSTATE"
fi

say "== 20. WebDAV mount (Pufflet as a remote) =="
# The DAV mount reuses API keys as WebDAV passwords (HTTP Basic); the server
# itself needs no rclone binary, so the curl-level checks below always run.
DAVAUTH=(-u "pufflet:$TOK")
code=$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND "$BASE/api/dav")
check "dav PROPFIND without credentials is 401" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND "$BASE/api/dav" -u "pufflet:tc_live_wrongkey123")
check "dav PROPFIND with a wrong key is 401" "$code" "401"
OPTS=$(curl -s -i -X OPTIONS "$BASE/api/dav" | tr -d '\r')
contains "dav OPTIONS advertises class 1" "$OPTS" "dav: 1"
contains "dav OPTIONS lists the DAV methods" "$OPTS" "PROPFIND, MKCOL, MOVE, COPY"

code=$(curl -s -o /dev/null -w '%{http_code}' -X MKCOL "$BASE/api/dav/dav-e2e" "${DAVAUTH[@]}")
check "MKCOL creates a folder (201)" "$code" "201"
code=$(curl -s -o /dev/null -w '%{http_code}' -X MKCOL "$BASE/api/dav/dav-e2e" "${DAVAUTH[@]}")
check "MKCOL on an existing folder is 405" "$code" "405"
code=$(curl -s -o /dev/null -w '%{http_code}' -X MKCOL "$BASE/api/dav/dav-e2e/sub" "${DAVAUTH[@]}")
check "MKCOL creates a nested folder (201)" "$code" "201"
code=$(curl -s -o /dev/null -w '%{http_code}' -X MKCOL "$BASE/api/dav/no-such-parent/x" "${DAVAUTH[@]}")
check "MKCOL under a missing parent is 409" "$code" "409"

printf 'webdav hello %s\n' "$RANDOM" > "$T/dav-src.txt"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}" -H 'content-type: text/plain' --data-binary @"$T/dav-src.txt")
check "PUT uploads a file (201)" "$code" "201"
curl -s "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}" -o "$T/dav-dl.txt"
if diff -q "$T/dav-src.txt" "$T/dav-dl.txt" >/dev/null 2>&1; then
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: DAV GET returns byte-identical content"
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: DAV GET bytes differ"
fi

printf 'webdav v2 %s\n' "$RANDOM" > "$T/dav-src2.txt"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}" -H 'content-type: text/plain' --data-binary @"$T/dav-src2.txt")
check "PUT over an existing file is 204 (replace semantics)" "$code" "204"
curl -s "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}" -o "$T/dav-dl2.txt"
if diff -q "$T/dav-src2.txt" "$T/dav-dl2.txt" >/dev/null 2>&1; then
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: PUT overwrite replaced the content"
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: PUT overwrite content differs"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/dav/ghost-parent/x.txt" "${DAVAUTH[@]}" --data-binary 'x')
check "PUT under a missing parent is 409" "$code" "409"

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/dav/dav-e2e/caf%C3%A9%20na%C3%AFve.txt" "${DAVAUTH[@]}" --data-binary 'unicode')
check "PUT with a UTF-8 name works (201)" "$code" "201"
PF=$(curl -s -X PROPFIND "$BASE/api/dav/dav-e2e" -H 'Depth: 1' "${DAVAUTH[@]}")
contains "PROPFIND lists the UTF-8 name decoded" "$PF" 'café naïve'
code=$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND "$BASE/api/dav" -H 'Depth: 1' "${DAVAUTH[@]}")
check "PROPFIND root depth 1 is 207" "$code" "207"
PFR=$(curl -s -X PROPFIND "$BASE/api/dav" -H 'Depth: 1' "${DAVAUTH[@]}")
contains "PROPFIND root lists the DAV folder" "$PFR" 'dav-e2e'
PFI=$(curl -s -X PROPFIND "$BASE/api/dav" -H 'Depth: infinity' "${DAVAUTH[@]}")
contains "Depth: infinity includes the nested folder" "$PFI" 'sub'

code=$(curl -s -o /dev/null -w '%{http_code}' -X MOVE "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}" -H "Destination: $BASE/api/dav/dav-e2e/renamed.txt")
check "MOVE renames a file (201)" "$code" "201"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dav/dav-e2e/hello.txt" "${DAVAUTH[@]}")
check "old name is gone after MOVE (404)" "$code" "404"
curl -s "$BASE/api/dav/dav-e2e/renamed.txt" "${DAVAUTH[@]}" -o "$T/dav-moved.txt"
if diff -q "$T/dav-src2.txt" "$T/dav-moved.txt" >/dev/null 2>&1; then
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: MOVE kept the bytes"
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: MOVE content differs"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' -X MOVE "$BASE/api/dav/dav-e2e/renamed.txt" "${DAVAUTH[@]}" -H "Destination: $BASE/api/dav/dav-e2e/sub/moved.txt")
check "MOVE into a subfolder works (201)" "$code" "201"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dav/dav-e2e/renamed.txt" "${DAVAUTH[@]}")
check "source gone after cross-folder MOVE (404)" "$code" "404"

code=$(curl -s -o /dev/null -w '%{http_code}' -X COPY "$BASE/api/dav/dav-e2e/sub/moved.txt" "${DAVAUTH[@]}" -H "Destination: $BASE/api/dav/dav-e2e/copied.txt")
check "COPY duplicates a file (201)" "$code" "201"
curl -s "$BASE/api/dav/dav-e2e/copied.txt" "${DAVAUTH[@]}" -o "$T/dav-copied.txt"
if diff -q "$T/dav-src2.txt" "$T/dav-copied.txt" >/dev/null 2>&1; then
  PASS_COUNT=$((PASS_COUNT+1)); say "  ok: COPY duplicated the bytes"
else
  FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: COPY content differs"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dav/dav-e2e/sub/moved.txt" "${DAVAUTH[@]}")
check "COPY left the source intact (200)" "$code" "200"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/dav/dav-e2e/copied.txt" "${DAVAUTH[@]}")
check "DELETE removes a file (204)" "$code" "204"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dav/dav-e2e/copied.txt" "${DAVAUTH[@]}")
check "deleted file is gone (404)" "$code" "404"

# scope enforcement: a read-only key can list/download but never mutate
RK=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" "${XFF[@]}" -H 'content-type: application/json' -d '{"name":"dav-readonly","scopes":["read"]}')
RTOK=$(echo "$RK" | sed 's/.*"token":"\([^"]*\)".*/\1/')
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/dav/dav-e2e/sub/moved.txt" -u "pufflet:$RTOK" --data-binary 'nope')
check "read-only key cannot PUT (403)" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/dav/dav-e2e/sub/moved.txt" -u "pufflet:$RTOK")
check "read-only key cannot DELETE (403)" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND "$BASE/api/dav" -H 'Depth: 0' -u "pufflet:$RTOK")
check "read-only key can PROPFIND (207)" "$code" "207"
curl -s -X DELETE "$BASE/api/keys/$(echo "$RK" | sed 's/.*"id":"\([^"]*\)".*/\1/')" -b "$COOKIE" >/dev/null

# real-rclone client probe: mount Pufflet AS a webdav remote and drive it
# with the actual rclone binary (downloaded on demand, skipped offline).
RLC=""
if command -v rclone >/dev/null 2>&1; then RLC="$(command -v rclone)"; fi
if [ -z "$RLC" ] && [ -x /tmp/e2e-rclone/rclone ]; then RLC=/tmp/e2e-rclone/rclone; fi
if [ -z "$RLC" ]; then
  say "  -- no local rclone; trying a one-time download for the client probe --"
  if curl -fsSL --max-time 120 "https://downloads.rclone.org/rclone-current-linux-amd64.zip" -o "$T/rclone.zip" 2>/dev/null; then
    mkdir -p /tmp/e2e-rclone-dl
    if python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$T/rclone.zip" /tmp/e2e-rclone-dl 2>/dev/null; then
      RLC=$(ls /tmp/e2e-rclone-dl/rclone-*/rclone 2>/dev/null | head -1)
      [ -n "$RLC" ] && chmod +x "$RLC"
    fi
  fi
fi
if [ -z "$RLC" ]; then
  say "  skip: real-rclone client probe (no binary available)"
else
  say "  -- real rclone client probe ($("$RLC" version 2>/dev/null | head -1)) --"
  OBSCURED=$("$RLC" obscure "$TOK" 2>/dev/null)
  CONN=":webdav,url=\"${BASE}/api/dav\",vendor=other,user=e2e,pass=${OBSCURED}:"
  LSF=$("$RLC" lsf "$CONN" --max-depth 1 2>&1)
  contains "rclone lsf browses Pufflet as a remote" "$LSF" 'dav-e2e/'
  printf 'rclone client write %s\n' "$RANDOM" > "$T/rc-client.txt"
  "$RLC" copyto "$T/rc-client.txt" "$CONN"dav-e2e/sub/rclone-client.txt >/dev/null 2>&1
  curl -s "$BASE/api/dav/dav-e2e/sub/rclone-client.txt" "${DAVAUTH[@]}" -o "$T/rc-client-dl.txt"
  if diff -q "$T/rc-client.txt" "$T/rc-client-dl.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: rclone copyto uploads byte-perfect into Pufflet"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: rclone copyto upload bytes differ"
  fi
  mkdir -p "$T/dav-out"
  "$RLC" copy "$CONN"dav-e2e/sub "$T/dav-out" >/dev/null 2>&1
  if diff -q "$T/rc-client.txt" "$T/dav-out/rclone-client.txt" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT+1)); say "  ok: rclone copy downloads byte-perfect from Pufflet"
  else
    FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: rclone copy download bytes differ"
  fi
  "$RLC" deletefile "$CONN"dav-e2e/sub/rclone-client.txt >/dev/null 2>&1
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dav/dav-e2e/sub/rclone-client.txt" "${DAVAUTH[@]}")
  check "rclone deletefile removed the file (404)" "$code" "404"
fi

# cleanup: DAV DELETE trashes, so purge the e2e folder for real
curl -s -X DELETE "$BASE/api/dav/dav-e2e" "${DAVAUTH[@]}" >/dev/null
DEVID=$(curl -s "$BASE/api/folders?all=1" -b "$COOKIE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(f['id'] for f in d['folders'] if f['name']=='dav-e2e'))" 2>/dev/null)
[ -n "$DEVID" ] && curl -s -X DELETE "$BASE/api/folders/$DEVID?permanent=1" -b "$COOKIE" >/dev/null

say ""
say "==================================="
say "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT"
say "==================================="
rm -rf "$T"
[ "$FAIL_COUNT" = "0" ]
