# [tenki] Container image for apps/agent (the eve durable research agent).
#
# `eve build` emits a Nitro server under .output/ plus compiled artefacts in
# .eve/. Per eve's self-hosting guide the run command is `eve start`, so the eve
# CLI must be present at runtime — this is not a copy-the-bundle-and-go image.
#
# `eve build` evaluates the authored modules, so DATABASE_URL must be *set* at
# build time (@crm/db throws without it). It is never connected to; the real one
# is injected at runtime.
#
# STATE: eve keeps durable session/workflow state under .eve/.workflow-data.
# That path must be a PersistentVolume in Kubernetes or every redeploy silently
# drops in-flight research sessions — the one thing eve exists to prevent.

FROM oven/bun:1.3.12-debian AS base
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
FROM base AS deps
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
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
# prisma.config.ts imports @crm/env/load, so that workspace package's SOURCE
# must exist before postinstall runs `prisma generate` — manifests alone give
# "Cannot find module '@crm/env/load'". It is ~32K of TypeScript with no build
# step, so copying it here is cheap and keeps the deps layer cacheable.
COPY packages/env packages/env
COPY apps/api/scripts/chmod-trpc-binary.mjs apps/api/scripts/
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN bun install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM base AS build
COPY . .
COPY --from=deps /repo/node_modules ./node_modules
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
    CRM_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN bun install --frozen-lockfile \
 && bun run --filter=@crm/db db:generate \
 && bun run --filter=agent build

# ---- runtime ----------------------------------------------------------------
FROM oven/bun:1.3.12-debian AS runtime
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=2000

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs agent

COPY --from=build --chown=agent:nodejs /repo/node_modules   ./node_modules
COPY --from=build --chown=agent:nodejs /repo/package.json   ./package.json
COPY --from=build --chown=agent:nodejs /repo/apps/agent     ./apps/agent
COPY --from=build --chown=agent:nodejs /repo/packages       ./packages

USER agent
EXPOSE 2000
WORKDIR /repo/apps/agent
CMD ["bun", "run", "start"]
