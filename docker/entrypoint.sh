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
  # Pre-flight validation — telegram-bot-api exits immediately (usage dump /
  # "You must provide valid api-id and api-hash") on any of these, and the old
  # behavior hid WHY. Catch each mistake with a targeted message instead.
  bot_api_skip=""
  case "${TELEGRAM_API_ID}" in
    *[!0-9]*)
      bot_api_skip="TELEGRAM_API_ID must be a plain number — got '${TELEGRAM_API_ID}' (no quotes, no spaces, and not the api_hash)."
      ;;
  esac
  if [ -z "$bot_api_skip" ]; then
    # --api-id is parsed as a signed 32-bit int; bigger values make the binary
    # print its usage text and exit. Strip leading zeros first — POSIX
    # arithmetic would otherwise read "0072" as octal.
    api_id_norm="${TELEGRAM_API_ID}"
    while [ "${api_id_norm#0}" != "$api_id_norm" ]; do api_id_norm="${api_id_norm#0}"; done
    [ -z "$api_id_norm" ] && api_id_norm=0
    if [ "$((api_id_norm < 1 || api_id_norm > 2147483647))" = 1 ]; then
      bot_api_skip="TELEGRAM_API_ID '${TELEGRAM_API_ID}' is outside the valid range 1-2147483647. It must be the App api_id from my.telegram.org (a small number like 1234567) — if this is the number at the start of your bot token, that is the BOT id, not api_id."
    fi
  fi
  if [ -z "$bot_api_skip" ]; then
    api_hash_ok=1
    case "${TELEGRAM_API_HASH}" in *[!0-9a-fA-F]*) api_hash_ok=0 ;; esac
    [ "${#TELEGRAM_API_HASH}" -ne 32 ] && api_hash_ok=0
    if [ "$api_hash_ok" = 0 ]; then
      bot_api_skip="TELEGRAM_API_HASH must be the 32-character hex string from my.telegram.org -> API development tools — got ${#TELEGRAM_API_HASH} character(s): '${TELEGRAM_API_HASH}'."
    fi
  fi

  if [ -n "$bot_api_skip" ]; then
    echo "[pufflet] WARNING: $bot_api_skip" >&2
    echo "[pufflet] Skipping embedded Local Bot API; the app will use hosted limits (50 MB) until these env vars are fixed." >&2
  else
    BOT_API_DIR="${BOT_API_DIR:-/tmp/pufflet-bot-api}"
    mkdir -p "$BOT_API_DIR/tmp"
    echo "[pufflet] starting embedded Local Bot API server on :8081 (work dir $BOT_API_DIR)..."
    # NOTE: no --logverbosity here — Bot API 10.x removed that flag (renamed
    # to --verbosity) and the binary exits with a usage dump on ANY
    # unrecognized option. Keep this arg list to the long-stable core flags;
    # verify against `telegram-bot-api --help` of the pinned image version
    # before adding anything new.
    /usr/local/bin/telegram-bot-api \
      --api-id "$TELEGRAM_API_ID" \
      --api-hash "$TELEGRAM_API_HASH" \
      --local \
      --http-port 8081 \
      --dir "$BOT_API_DIR" \
      --temp-dir "$BOT_API_DIR/tmp" > "$BOT_API_DIR/bot-api.log" 2>&1 &
    echo $! > /tmp/pufflet-bot-api.pid

    # Wait until the HTTP endpoint answers (any response, even 404, means up)
    # or the process dies (bad arguments / crash -> fail fast, never stall).
    bot_api_ok=1
    tries=0
    until node -e "fetch('http://127.0.0.1:8081/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; do
      if ! kill -0 "$(cat /tmp/pufflet-bot-api.pid 2>/dev/null)" 2>/dev/null; then
        echo "[pufflet] ERROR: embedded telegram-bot-api exited immediately. Its output:" >&2
        if [ -s "$BOT_API_DIR/bot-api.log" ]; then
          sed 's/^/[bot-api] /' "$BOT_API_DIR/bot-api.log" | tail -n 20 >&2
        else
          echo "[bot-api] (no output captured — the binary crashed before logging anything)" >&2
        fi
        echo "[pufflet] Fix the env vars flagged above and redeploy. The app will still boot, using hosted limits (50 MB)." >&2
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
  fi
elif [ -n "${TELEGRAM_API_BASE}" ]; then
  echo "[pufflet] using external Bot API server at ${TELEGRAM_API_BASE}"
else
  echo "[pufflet] using hosted Bot API (limits: 50 MB up / 20 MB down)"
fi

echo "[pufflet] starting server on port ${PORT:-7860}..."
exec node server.js
