#!/usr/bin/env bash
# First-time TLS certificate for $DOMAIN via Let's Encrypt (webroot, served by the
# compose nginx). Run once, after DNS for $DOMAIN points at this instance and ports
# 80/443 are open. Renewal is automatic afterwards (certbot service + nginx reload).
#
#   bash deploy/scripts/init-letsencrypt.sh            # real certificate
#   STAGING=1 bash deploy/scripts/init-letsencrypt.sh  # LE staging (no rate limits) to test
#
# Why the dummy certificate: nginx refuses to start when ssl_certificate points at a
# missing file, but the ACME challenge must be answered by that same nginx. So: write a
# throwaway self-signed cert, start nginx, delete it, obtain the real one, reload.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."
compose=(docker compose -f docker-compose.prod.yml)

env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DOMAIN="$(env_get DOMAIN)"
EMAIL="$(env_get LETSENCRYPT_EMAIL)"
if [ -z "$DOMAIN" ]; then
  echo "init-letsencrypt: set DOMAIN in deploy/.env" >&2
  exit 1
fi
# An email is strongly recommended (expiry and revocation notices); without one the
# account is registered anonymously.
if [ -n "$EMAIL" ]; then email_args=(--email "$EMAIL"); else email_args=(--register-unsafely-without-email); fi

live="/etc/letsencrypt/live/$DOMAIN"
if "${compose[@]}" run --rm --no-deps --entrypoint sh certbot -c "test -f $live/fullchain.pem && ! test -f $live/.dummy" 2>/dev/null; then
  if [ "${FORCE:-0}" != "1" ]; then
    echo "A real certificate for $DOMAIN already exists. FORCE=1 to replace it." >&2
    exit 0
  fi
fi

echo "==> Dummy certificate for $DOMAIN"
"${compose[@]}" run --rm --no-deps --entrypoint sh certbot -c "
  mkdir -p $live &&
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $live/privkey.pem -out $live/fullchain.pem -subj /CN=localhost &&
  touch $live/.dummy"

echo "==> Starting nginx"
# api/web must exist for nginx's depends_on; they may still be unhealthy/unmigrated —
# nginx resolves upstreams lazily, so it serves the ACME challenge regardless.
"${compose[@]}" up -d --no-deps nginx

echo "==> Removing dummy certificate"
"${compose[@]}" run --rm --no-deps --entrypoint sh certbot -c "
  rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"

echo "==> Requesting Let's Encrypt certificate for $DOMAIN"
staging=()
[ "${STAGING:-0}" = "1" ] && staging=(--staging)
"${compose[@]}" run --rm --no-deps --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  "${staging[@]}" \
  -d "$DOMAIN" \
  "${email_args[@]}" --agree-tos --no-eff-email \
  --rsa-key-size 4096 --non-interactive --force-renewal

echo "==> Reloading nginx"
"${compose[@]}" exec nginx nginx -s reload
echo "==> Certificate installed for https://$DOMAIN (auto-renews via the certbot service)"
