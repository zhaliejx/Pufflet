# Pufflet — production image (Next.js standalone + Prisma CLI for boot-time db push)
#
# Build:  docker build -t pufflet .
# Run:    docker compose up -d        (recommended — also starts the Local Bot API server)

# ---- deps + build (bun for fast, lockfile-faithful installs) ----------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is only needed for prisma generate (no DB access at build time).
ENV DATABASE_URL="file:/tmp/build.db"
RUN bunx prisma generate && bun run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

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

RUN mkdir -p /app/db \
    && chown -R node:node /app \
    && chmod +x ./entrypoint.sh

USER node
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
