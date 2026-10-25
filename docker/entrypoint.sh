#!/bin/sh
# Pufflet container entrypoint:
#   1. sync the database schema
#   2. optionally start the embedded Local Bot API server (when TELEGRAM_API_ID
#      + TELEGRAM_API_HASH are set) and point the app at it
#   3. start the Next.js server
set -e

: "${DATABASE_URL:=file:/app/db/pufflet.db}"
export DATABASE_URL
mkdir -p /app/db

echo "[pufflet] syncing database schema (prisma db push)..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss

if [ -n "${TELEGRAM_API_ID}" ] && [ -n "${TELEGRAM_API_HASH}" ]; then
  case "${TELEGRAM_API_ID}" in
    *[!0-9]*)
      # telegram-bot-api exits with a usage dump on a non-numeric api-id,
      # which used to leave us waiting 60s+ for a dead server before boot.
      echo "[pufflet] WARNING: TELEGRAM_API_ID must be a plain number from my.telegram.org (no quotes, spaces or the api_hash) — got '${TELEGRAM_API_ID}'." >&2
      echo "[pufflet] Skipping embedded Local Bot API; the app will use hosted limits until this env var is fixed." >&2
      ;;
    *)
      BOT_API_DIR="${BOT_API_DIR:-/tmp/pufflet-bot-api}"
      mkdir -p "$BOT_API_DIR"
      echo "[pufflet] starting embedded Local Bot API server on :8081 (work dir $BOT_API_DIR)..."
      /usr/local/bin/telegram-bot-api \
        --api-id "$TELEGRAM_API_ID" \
        --api-hash "$TELEGRAM_API_HASH" \
        --local \
        --http-port 8081 \
        --dir "$BOT_API_DIR" \
        --temp-dir "$BOT_API_DIR/tmp" \
        --logverbosity 1 &
      echo $! > /tmp/pufflet-bot-api.pid

      # Wait until the HTTP endpoint answers (any response, even 404, means up)
      # or the process dies (bad arguments / crash -> fail fast, never stall).
      bot_api_ok=1
      tries=0
      until node -e "fetch('http://127.0.0.1:8081/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; do
        if ! kill -0 "$(cat /tmp/pufflet-bot-api.pid 2>/dev/null)" 2>/dev/null; then
          echo "[pufflet] ERROR: embedded telegram-bot-api exited immediately — check its output above (usually TELEGRAM_API_ID not numeric, or TELEGRAM_API_HASH wrong)." >&2
          bot_api_ok=0
          break
        fi
        tries=$((tries + 1))
        if [ "$tries" -ge 90 ]; then
          echo "[pufflet] WARNING: Local Bot API server not ready after 45s — continuing anyway." >&2
          bot_api_ok=0
          break
        fi
        sleep 0.5
      done

      if [ "$bot_api_ok" = 1 ]; then
        : "${TELEGRAM_API_BASE:=http://127.0.0.1:8081}"
        export TELEGRAM_API_BASE
        : "${MAX_UPLOAD_MB:=2000}"
        export MAX_UPLOAD_MB
        : "${MAX_DOWNLOAD_MB:=2000}"
        export MAX_DOWNLOAD_MB
        echo "[pufflet] using embedded Local Bot API (limits: ${MAX_UPLOAD_MB} MB up / ${MAX_DOWNLOAD_MB} MB down)"
      else
        echo "[pufflet] continuing WITHOUT embedded Local Bot API (hosted limits apply)."
      fi
      ;;
  esac
elif [ -n "${TELEGRAM_API_BASE}" ]; then
  echo "[pufflet] using external Bot API server at ${TELEGRAM_API_BASE}"
else
  echo "[pufflet] using hosted Bot API (limits: 50 MB up / 20 MB down)"
fi

echo "[pufflet] starting server on port ${PORT:-7860}..."
exec node server.js
