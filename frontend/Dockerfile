# syntax=docker/dockerfile:1
# Build context: frontend/  (docker build -f Dockerfile frontend/)
#
# NEXT_PUBLIC_* values are inlined into the client bundle (and the CSP) at build time,
# so NEXT_PUBLIC_API_URL is a REQUIRED build arg — there is deliberately no localhost
# default that could ship to production unnoticed. At runtime the server reads
# API_INTERNAL_URL (e.g. http://api:4000/api/v1) for server-side fetches.
#   docker build --build-arg NEXT_PUBLIC_API_URL=https://desk.example.com/api/v1 \
#                --build-arg NEXT_PUBLIC_SOCKET_URL=https://desk.example.com .

# --- base ----------------------------------------------------------------
FROM node:22-bookworm-slim AS base
# Pinned pnpm via npm rather than corepack. Keep in sync with frontend/package.json.
RUN npm i -g pnpm@10.33.0 && npm cache clean --force
ENV CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_API_URL
# Optional: defaults to the API's origin (next.config.mjs / the socket hooks).
ARG NEXT_PUBLIC_SOCKET_URL=""
ARG NEXT_PUBLIC_APP_VERSION=""
RUN if [ -z "$NEXT_PUBLIC_API_URL" ]; then \
      echo "ERROR: build arg NEXT_PUBLIC_API_URL is required (e.g. https://desk.example.com/api/v1)" >&2; \
      exit 1; \
    fi
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL \
    NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
# next.config.mjs sets output: 'standalone', producing .next/standalone/server.js
# with only the node_modules the server actually imports.
RUN pnpm build && mkdir -p public

# --- runtime -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
