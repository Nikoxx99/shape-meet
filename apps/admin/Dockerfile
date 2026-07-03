# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --filter @shape-meet/admin... --prod=false

FROM node:22-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @shape-meet/admin build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl wget
RUN corepack enable
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
RUN mkdir -p /app/artifacts && chown -R nextjs:nodejs /app/artifacts

COPY --from=builder --chown=nextjs:nodejs /repo/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=builder --chown=nextjs:nodejs /repo/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/package.json ./apps/admin/package.json
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/public ./apps/admin/public
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/lib ./apps/admin/lib
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/prisma.config.ts ./apps/admin/prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /repo/apps/admin/prisma ./apps/admin/prisma
COPY --chown=nextjs:nodejs apps/admin/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1
CMD ["./docker-entrypoint.sh"]
