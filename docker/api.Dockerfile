# [tenki] Container image for apps/api (NestJS + tRPC).
#
# `bun build --packages=external` deliberately does NOT bundle dependencies, so
# dist/main.js alone is not runnable — the image keeps node_modules and Bun.
#
# Also doubles as the MIGRATION image: `prisma migrate deploy` needs the schema
# and the migrations directory, both of which are present here. The migration Job
# runs this image with a different command, so the schema that ships can never
# drift from the API that reads it.
#
# apps/api/src/generated/server.ts is committed upstream and the build must never
# regenerate it (the generator needs a newer GLIBC than most build images have) —
# `bun run build` does not, so nothing extra is needed here. Do not add a
# trpc:generate step.

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
 && bun run --filter=api build

# ---- runtime ----------------------------------------------------------------
FROM oven/bun:1.3.12-debian AS runtime
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=3001

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs api

COPY --from=build --chown=api:nodejs /repo/node_modules      ./node_modules
COPY --from=build --chown=api:nodejs /repo/package.json      ./package.json
COPY --from=build --chown=api:nodejs /repo/apps/api          ./apps/api
COPY --from=build --chown=api:nodejs /repo/packages          ./packages

USER api
EXPOSE 3001
WORKDIR /repo/apps/api
# `bun dist/main.js` is upstream's start:prod.
CMD ["bun", "dist/main.js"]
