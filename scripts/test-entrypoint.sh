#!/bin/sh
# Smoke-test docker/entrypoint.sh branch logic with stubs (no docker needed).
# Covers: non-numeric api-id skip, oversized api-id (bot-token-prefix) skip,
# malformed api_hash skip, instant-death fail-fast (with captured bot-api
# output echoed back), healthy success path, and the no-embedded modes
# (external base / hosted).
set -e
cd "$(dirname "$0")/.."
T=.sim-test
rm -rf "$T" && mkdir -p "$T/stub-db"

HASH_OK=deadbeefdeadbeefdeadbeefdeadbeef   # 32 hex chars — valid shape

# --- stub telegram-bot-api binaries -----------------------------------------
cat > "$T/botapi-dies" <<'EOF'
#!/bin/sh
echo "fake-bot-api: usage dump — --proxy=<arg>  HTTP proxy server for outgoing webhook requests"
exit 1
EOF
cat > "$T/botapi-works" <<'EOF'
#!/bin/sh
exec node -e "require('http').createServer((q,s)=>{s.writeHead(404);s.end('{}')}).listen(8081,()=>{setTimeout(()=>process.exit(0),8000)})"
EOF
chmod +x "$T/botapi-dies" "$T/botapi-works"

# --- build a stubbed copy of the real entrypoint -----------------------------
make_stub() {
  sed -e 's|^node node_modules/prisma/build/index.js db push.*|echo "[stub] db push ok"|' \
      -e "s|/usr/local/bin/telegram-bot-api|$1|" \
      -e 's|^mkdir -p /app/db$|mkdir -p .sim-test/stub-db|' \
      -e 's|^exec node server.js$|echo "[stub] exec node server.js"|' \
      docker/entrypoint.sh > "$T/entrypoint.sh"
  chmod +x "$T/entrypoint.sh"
}

echo "=== case 1: TELEGRAM_API_ID not numeric (pasted quotes) -> skip, no stall"
make_stub "$T/botapi-dies"
TELEGRAM_API_ID='"1234567"' TELEGRAM_API_HASH="$HASH_OK" sh "$T/entrypoint.sh"

echo
echo "=== case 2: TELEGRAM_API_ID is the bot-token prefix (8768064067 > int32) -> targeted warning, no stall"
TELEGRAM_API_ID=8768064067 TELEGRAM_API_HASH="$HASH_OK" sh "$T/entrypoint.sh"

echo
echo "=== case 3: TELEGRAM_API_ID=0 -> range warning, no stall"
TELEGRAM_API_ID=0 TELEGRAM_API_HASH="$HASH_OK" sh "$T/entrypoint.sh"

echo
echo "=== case 4: TELEGRAM_API_HASH is the bot token (wrong shape) -> targeted warning, no stall"
TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH='8768064067:AAEzexample' sh "$T/entrypoint.sh"

echo
echo "=== case 5: valid id+hash but bot-api dies instantly -> fail-fast, captured output echoed"
TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH="$HASH_OK" sh "$T/entrypoint.sh"

echo
echo "=== case 6: valid id+hash, bot-api healthy -> embedded mode + 2000 MB limits"
make_stub "$T/botapi-works"
TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH="$HASH_OK" sh "$T/entrypoint.sh"

echo
echo "=== case 7: no api id/hash, external TELEGRAM_API_BASE -> external mode"
make_stub "$T/botapi-dies"
TELEGRAM_API_BASE=https://example.org sh "$T/entrypoint.sh"

echo
echo "=== case 8: nothing set -> hosted mode"
sh "$T/entrypoint.sh"

rm -rf "$T"
echo
echo "ALL ENTRYPOINT BRANCH TESTS PASSED"
