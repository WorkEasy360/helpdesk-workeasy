# syntax=docker/dockerfile:1
# Build context: backend/  (docker build -f api/Dockerfile backend/)
#
# One image serves two roles:
#   - the API            (default CMD: node dist/main.js)
#   - the migrate job    (pnpm --filter @digisoft/db migrate:deploy)
# so the runtime keeps pnpm and a Prisma CLI pinned to the lockfile's version, and
# everything else is pruned to production dependencies.

# --- base ----------------------------------------------------------------
FROM node:22-bookworm-slim AS base
# openssl: Prisma's query/schema engines link against it (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Pinned pnpm via npm rather than corepack (corepack's signing-key check has broken
# builds before). Keep in sync with "packageManager" in backend/package.json.
RUN npm i -g pnpm@10.33.0 && npm cache clean --force
ENV CI=true PNPM_HOME=/pnpm
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
# Every workspace manifest must be present before `pnpm install`, or pnpm won't
# recognize a workspace project and its dependencies (prisma's CLI, most notably)
# silently never get installed. Keep in sync with api's "workspace:*" dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/channels/package.json packages/channels/
COPY packages/ai/package.json packages/ai/
COPY packages/analytics/package.json packages/analytics/
COPY packages/storage/package.json packages/storage/
COPY api/package.json api/
RUN pnpm install --frozen-lockfile --filter "@digisoft/api..."
COPY packages ./packages
COPY api ./api
# `...` = the api plus every workspace package it depends on, in dependency order.
# packages/db's build runs `prisma generate` before its tsc.
RUN pnpm --filter "@digisoft/api..." build
# Prune to production dependencies in place (keeps the built dist/ folders).
RUN pnpm install --frozen-lockfile --prod --offline --filter "@digisoft/api..." \
 && rm -rf packages/*/src api/src api/test \
 && find . -name "*.tsbuildinfo" -delete
# The Prisma CLI that stays in the image for `migrate:deploy`: the exact version
# the lockfile resolved, so the CLI and @prisma/client never disagree.
RUN PRISMA_VERSION="$(node -p "require('/app/packages/db/node_modules/@prisma/client/package.json').version")" \
 && echo "$PRISMA_VERSION" > /prisma-version

# --- runtime -------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /prisma-version /prisma-version
RUN npm i -g "prisma@$(cat /prisma-version)" && npm cache clean --force
# Root-owned, so the app user can read but not modify its own code and dependencies;
# only the storage directory below is writable.
COPY --from=build /app /app
# Regenerate the client against the pruned tree (a prod-only reinstall can drop the
# generated .prisma/client); cheap and makes the image independent of prune behaviour.
RUN cd /app/packages/db && prisma generate --schema prisma/schema.prisma
# Default path for STORAGE_PROVIDER=local; owned by the non-root user so a fresh
# named volume mounted here inherits writable ownership.
RUN mkdir -p /var/lib/digisoft/storage && chown -R node:node /var/lib/digisoft
USER node
WORKDIR /app/api
EXPOSE 4000
# Liveness: /health/live if the app has it, otherwise /health (which also checks
# Postgres and Redis). Compose uses /health for readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const b='http://127.0.0.1:'+(process.env.PORT||4000)+'/'+(process.env.API_PREFIX||'api/v1');fetch(b+'/health/live').then(r=>r.status===404?fetch(b+'/health'):r).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
