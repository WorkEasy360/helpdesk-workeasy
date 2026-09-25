# syntax=docker/dockerfile:1
# Build context: backend/  (docker build -f worker/Dockerfile backend/)

# --- base ----------------------------------------------------------------
FROM node:22-bookworm-slim AS base
# openssl: Prisma's query engine links against it (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Pinned pnpm via npm rather than corepack. Keep in sync with backend/package.json.
RUN npm i -g pnpm@10.33.0 && npm cache clean --force
ENV CI=true
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
# Every workspace manifest the worker's graph reaches must be present before
# `pnpm install`. Keep in sync with worker's "workspace:*" dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/channels/package.json packages/channels/
COPY packages/ai/package.json packages/ai/
COPY packages/analytics/package.json packages/analytics/
COPY packages/storage/package.json packages/storage/
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile --filter "@digisoft/worker..."
COPY packages ./packages
COPY worker ./worker
RUN pnpm --filter "@digisoft/worker..." build
# Prune to production dependencies in place (keeps the built dist/ folders).
RUN pnpm install --frozen-lockfile --prod --offline --filter "@digisoft/worker..." \
 && rm -rf packages/*/src worker/src \
 && find . -name "*.tsbuildinfo" -delete
RUN node -p "require('/app/packages/db/node_modules/@prisma/client/package.json').version" > /prisma-version

# --- runtime -------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Root-owned, so the app user can read but not modify its own code and dependencies.
COPY --from=build /app /app
# Regenerate the Prisma client against the pruned tree with a throwaway CLI of the
# lockfile's exact version, then drop the CLI — the worker never migrates.
COPY --from=build /prisma-version /prisma-version
RUN cd /app/packages/db \
 && npx --yes "prisma@$(cat /prisma-version)" generate --schema prisma/schema.prisma \
 && rm -rf /root/.npm /tmp/*
RUN mkdir -p /var/lib/digisoft/storage && chown -R node:node /var/lib/digisoft
USER node
WORKDIR /app/worker
# No HTTP listener to probe; Compose restarts the container if the process exits.
CMD ["node", "dist/main.js"]
