#!/usr/bin/env bash
# Pufflet end-to-end API test suite.
# Requires: dev server on :3000, telegram-mock on :3031 (see mini-services).
# Usage: bash scripts/e2e_api_test.sh
set -u
BASE="http://localhost:3000"
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
  curl -s -i -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
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
say "== 1. auth =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"owner@pufflet.test","password":"wrong"}')
check "login rejects bad password (401)" "$code" "401"
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
K=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"test-suite","scopes":["read","write","delete"]}')
TOK=$(echo "$K" | sed 's/.*"token":"\([^"]*\)".*/\1/')
contains "token returned once with prefix" "$TOK" 'tc_live_'
KLIST=$(curl -s "$BASE/api/keys" -b "$COOKIE")
if echo "$KLIST" | grep -q "$TOK"; then FAIL_COUNT=$((FAIL_COUNT+1)); say "  FAIL: raw token stored/returned"; else PASS_COUNT=$((PASS_COUNT+1)); say "  ok: raw token never listed again"; fi
ME=$(curl -s "$BASE/api/v1/me" -H "Authorization: Bearer $TOK")
contains "v1 me works" "$ME" '"scopes"'
V1L=$(curl -s "$BASE/api/v1/files" -H "Authorization: Bearer $TOK")
contains "v1 list works" "$V1L" '"files"'
printf 'api upload %s' "$RANDOM" > "$T/api.txt"
V1J=$(curl -s -X POST "$BASE/api/v1/files" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d "{\"filename\":\"api-file.txt\",\"size\":$(stat -c%s "$T/api.txt")}")
V1UP=$(echo "$V1J" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')
V1F=$(curl -s -X PUT "$BASE/api/v1/uploads/$V1UP/data" -H "Authorization: Bearer $TOK" -H 'content-type: application/octet-stream' --data-binary @"$T/api.txt")
contains "v1 upload works" "$V1F" '"name":"api-file.txt"'
# read-only key cannot write
KR=$(curl -s -X POST "$BASE/api/keys" -b "$COOKIE" -H 'content-type: application/json' -d '{"name":"readonly","scopes":["read"]}')
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
  LAST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"ratelimit@x.test","password":"nope"}')
done
check "repeated failures rate-limited (429)" "$LAST" "429"

say ""
say "==================================="
say "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT"
say "==================================="
rm -rf "$T"
[ "$FAIL_COUNT" = "0" ]
