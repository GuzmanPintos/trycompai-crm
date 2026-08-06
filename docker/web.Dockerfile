# [tenki] Container image for apps/app (Next.js front end).
#
# Upstream deploys this on Vercel and ships no Dockerfile. Two things matter:
#
#  1. `API_URL` is a BUILD-TIME cache key (see turbo.json "build".env): next.config.ts
#     republishes it as NEXT_PUBLIC_API_URL and Next inlines it into the browser
#     bundle. Build with the wrong value and every deployed page calls the wrong
#     origin — the exact bug turbo.json's comment describes. So it is an ARG.
#  2. The build needs DATABASE_URL to exist because @crm/db's postinstall runs
#     `prisma generate`. It is never connected to at build time, so a syntactically
#     valid placeholder is enough — the real one is injected at runtime.
#
# Runtime is Next standalone (see the [tenki] patch in apps/app/next.config.ts),
# which emits a self-contained server.js plus a pruned node_modules.
#
# RUNTIME IS NODE, NOT BUN. Verified locally: `bun apps/app/server.js` on a Next
# 16 / Turbopack standalone build dies with
#   "Failed to load external module next/dist/compiled/next-server/
#    app-page-turbo.runtime.prod.js: Expected CommonJS module to have a function
#    wrapper"
# and every route 500s. The same build under `node` serves /sign-in 200. Bun is
# still the right tool for install and for the api/agent images; it just cannot
# run this particular server bundle.

FROM oven/bun:1.3.12-debian AS base
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
FROM base AS deps
# Bun needs the full workspace manifest set to resolve `workspace:*` links.
COPY package.json bun.lock turbo.json ./
COPY apps/app/package.json      apps/app/
COPY apps/api/package.json      apps/api/
COPY apps/agent/package.json    apps/agent/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json   packages/db/
COPY packages/env/package.json  packages/env/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/ui/package.json   packages/ui/
COPY packages/typescript-config/package.json packages/typescript-config/
# @crm/db postinstall runs `prisma generate`, which needs the schema present and
# DATABASE_URL resolvable.
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
COPY apps/api/scripts/chmod-trpc-binary.mjs apps/api/scripts/
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN bun install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM base AS build
# Source first, then the resolved dependency tree on top — .dockerignore keeps
# host node_modules out, so nothing here shadows the installed workspace links.
COPY . .
COPY --from=deps /repo/node_modules ./node_modules

ARG API_URL="http://localhost:3001"
ARG APP_URL="http://localhost:3000"
ENV API_URL=$API_URL \
    APP_URL=$APP_URL \
    NEXT_PUBLIC_API_URL=$API_URL \
    DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
    NEXT_TELEMETRY_DISABLED=1 \
    CRM_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Re-run install so per-workspace node_modules links exist for the newly copied
# source, then generate the Prisma client and build.
RUN bun install --frozen-lockfile \
 && bun run --filter=@crm/db db:generate \
 && bun run --filter=app build

# ---- runtime ----------------------------------------------------------------
# node, not bun — see the note at the top of this file.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nextjs-grp \
 && useradd --system --uid 1001 --gid nextjs-grp nextjs

# Next standalone output: server.js + pruned deps, then the two things tracing
# deliberately leaves out (static assets and public/). Paths are monorepo-shaped
# because outputFileTracingRoot is the repo root: server.js lands at
# apps/app/server.js, verified against a real build.
COPY --from=build --chown=nextjs:nextjs-grp /repo/apps/app/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs-grp /repo/apps/app/.next/static ./apps/app/.next/static
COPY --from=build --chown=nextjs:nextjs-grp /repo/apps/app/public ./apps/app/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/app/server.js"]
