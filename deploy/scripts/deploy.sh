#!/usr/bin/env bash
# Build, migrate, and (re)start the production stack. Run from anywhere on the host:
#
#   bash deploy/scripts/deploy.sh              # full release
#   SKIP_MIGRATE=1 bash deploy/scripts/deploy.sh   # code-only release, no schema change
#
# Order: preflight -> build images -> migrate (one-off, `prisma migrate deploy` only)
#        -> up -d -> wait for health -> prune old images.
# The first time, run scripts/init-letsencrypt.sh BEFORE this (nginx needs a cert).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "$here/.." && pwd)"
cd "$deploy_dir"

compose=(docker compose -f docker-compose.prod.yml)

# --- preflight -----------------------------------------------------------------
if [ ! -f .env ]; then
  echo "deploy: $deploy_dir/.env is missing — cp .env.example .env and fill it in" >&2
  exit 1
fi
if grep -nE '^[A-Z_]+=.*(replace-me|REPLACE_PASSWORD|example\.com|xxxxxxxx)' .env; then
  echo "deploy: the lines above still hold template placeholders — fill them in first" >&2
  exit 1
fi
if grep -nE '^(S3_ENDPOINT|S3_ACCESS_KEY|S3_SECRET_KEY)=\s*$' .env; then
  echo "deploy: remove the empty S3_* lines above entirely (an empty value is not 'unset')" >&2
  exit 1
fi
if ! grep -qE '^DATABASE_URL=.*[?&]schema=helpdesk(&|$)' .env; then
  echo "deploy: DATABASE_URL must include ?schema=helpdesk — the app must not touch the shared database's public schema" >&2
  exit 1
fi
bash "$here/check-migrations.sh"
"${compose[@]}" config -q

if git -C "$deploy_dir/.." rev-parse --short HEAD >/dev/null 2>&1; then
  export IMAGE_TAG="${IMAGE_TAG_OVERRIDE:-$(git -C "$deploy_dir/.." rev-parse --short HEAD)}"
fi
echo "==> Release ${IMAGE_TAG:-latest}"

# --- build ---------------------------------------------------------------------
# Sequential builds keep peak memory within a small instance (+ swap).
# SKIP_BUILD=1 uses images already loaded on the host (built elsewhere and shipped
# with `docker save | ssh ... docker load`), for instances too small to build.
# PULL=1 pulls them from the registry in IMAGE_PREFIX (the GitHub Actions deploy).
if [ "${PULL:-0}" = "1" ]; then
  echo "==> Pulling ${IMAGE_PREFIX:-digisoft}-{api,worker,web}:${IMAGE_TAG:-latest}"
  "${compose[@]}" pull api worker web
elif [ "${SKIP_BUILD:-0}" != "1" ]; then
  for svc in api worker web; do
    echo "==> Building $svc"
    "${compose[@]}" build "$svc"
  done
else
  for img in api worker web; do
    docker image inspect "${IMAGE_PREFIX:-digisoft}-$img:${IMAGE_TAG:-latest}" >/dev/null 2>&1 || {
      echo "deploy: SKIP_BUILD=1 but ${IMAGE_PREFIX:-digisoft}-$img:${IMAGE_TAG:-latest} is not loaded" >&2
      exit 1
    }
  done
  echo "==> SKIP_BUILD=1 — using preloaded images"
fi

# --- migrate -------------------------------------------------------------------
if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "==> Applying migrations (prisma migrate deploy) to schema helpdesk"
  "${compose[@]}" --profile migrate run --rm migrate
else
  echo "==> SKIP_MIGRATE=1 — not running migrations"
fi

# --- roll out --------------------------------------------------------------------
echo "==> Starting services"
"${compose[@]}" up -d --remove-orphans redis api worker web nginx certbot

echo "==> Waiting for api to report healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$("${compose[@]}" ps -q api)" 2>/dev/null || echo unknown)"
  if [ "$status" = healthy ]; then break; fi
  sleep 5
done
"${compose[@]}" ps
if [ "${status:-}" != healthy ]; then
  echo "deploy: api is '$status' — check: docker compose -f docker-compose.prod.yml logs --tail=100 api" >&2
  exit 1
fi

# Record what is running, so a manual `docker compose ... up -d` later on this host
# starts the same release instead of whatever IMAGE_TAG/IMAGE_PREFIX .env last held.
for kv in "IMAGE_TAG=${IMAGE_TAG:-latest}" "IMAGE_PREFIX=${IMAGE_PREFIX:-digisoft}"; do
  key="${kv%%=*}"
  if grep -qE "^$key=" .env; then sed -i "s|^$key=.*|$kv|" .env; else echo "$kv" >> .env; fi
done

# --- tidy ----------------------------------------------------------------------
# Dangling layers from previous builds; tagged images of the last releases are kept
# so a rollback is `IMAGE_TAG=<sha> docker compose ... up -d`.
docker image prune -f >/dev/null
docker builder prune -f --filter 'until=168h' >/dev/null || true
echo "==> Deployed ${IMAGE_TAG:-latest} — https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
