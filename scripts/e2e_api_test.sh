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

say ""
say "==================================="
say "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT"
say "==================================="
rm -rf "$T"
[ "$FAIL_COUNT" = "0" ]
