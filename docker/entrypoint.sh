#!/bin/sh
# Pufflet container entrypoint: sync the database schema, then start Next.js.
set -e

echo "[pufflet] syncing database schema (prisma db push)..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss

echo "[pufflet] starting server on port ${PORT:-3000}..."
exec node server.js
