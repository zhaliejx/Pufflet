# Pufflet — ALL-IN-ONE production image (Next.js app + optional embedded
# Telegram "Local Bot API" server in the SAME container).
#
#   docker build -t pufflet .
#   docker run -p 7860:7860 --env-file .env pufflet      # hosted mode (50 MB)
#
#   ...or with TELEGRAM_API_ID + TELEGRAM_API_HASH set, the container ALSO
#   spawns the official telegram-bot-api server on :8081 (loopback only) and
#   points the app at it -> 2000 MB uploads/downloads. No sidecar, no VPS
#   needed: this exact image runs FREE on Hugging Face Spaces, Render, Koyeb.
#
#   Prefer a separate sidecar? docker-compose.yml still works — it does not
#   pass TELEGRAM_API_ID/HASH to the app, so the embedded server stays off.
#
# Runtime is Alpine so the prebuilt telegram-bot-api binary (musl, from the
# aiogram image) runs natively; the bun builder stages are Alpine too, so all
# native deps (sharp, Prisma engines) are musl builds. HF Spaces run the
# container as user 1000 on port 7860 — that is exactly how this image is set up.

# ---- deps + build (bun for fast, lockfile-faithful installs) ----------------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is only needed for prisma generate (no DB access at build time).
ENV DATABASE_URL="file:/tmp/build.db"
RUN bunx prisma generate && bun run build

# ---- Local Bot API server binary (prebuilt, musl) ---------------------------
FROM aiogram/telegram-bot-api:latest AS botapi

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
# openssl: Prisma engines; libstdc++: telegram-bot-api binary
RUN apk add --no-cache openssl libstdc++
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=7860

# Next.js standalone server
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma CLI + client + schema for `db push` on boot (keeps the DB in sync
# without requiring a separate migrate step or the full node_modules).
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY docker/entrypoint.sh ./entrypoint.sh

# telegram-bot-api binary (runs only when TELEGRAM_API_ID/HASH are provided)
COPY --from=botapi /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

RUN mkdir -p /app/db \
    && chown -R node:node /app \
    && chmod +x ./entrypoint.sh /usr/local/bin/telegram-bot-api

# uid 1000 — required by Hugging Face Spaces, sensible everywhere else
USER node
EXPOSE 7860
ENTRYPOINT ["./entrypoint.sh"]
