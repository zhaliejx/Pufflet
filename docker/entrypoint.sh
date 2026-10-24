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

  # Wait until the HTTP endpoint answers (any response, even 404, means up).
  tries=0
  until node -e "fetch('http://127.0.0.1:8081/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      echo "[pufflet] WARNING: Local Bot API server not ready after 60s — continuing anyway." >&2
      break
    fi
    sleep 0.5
  done

  : "${TELEGRAM_API_BASE:=http://127.0.0.1:8081}"
  export TELEGRAM_API_BASE
  : "${MAX_UPLOAD_MB:=2000}"
  export MAX_UPLOAD_MB
  : "${MAX_DOWNLOAD_MB:=2000}"
  export MAX_DOWNLOAD_MB
  echo "[pufflet] using embedded Local Bot API (limits: ${MAX_UPLOAD_MB} MB up / ${MAX_DOWNLOAD_MB} MB down)"
fi

echo "[pufflet] starting server on port ${PORT:-7860}..."
exec node server.js
