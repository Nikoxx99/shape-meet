#!/bin/sh
set -e

cd /app/apps/admin
./node_modules/.bin/prisma migrate deploy

if [ "$RUN_SEED" = "true" ]; then
  ./node_modules/.bin/tsx prisma/seed.ts
fi

cd /app
exec node -r /app/apps/admin/keepalive.js apps/admin/server.js
