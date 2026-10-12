# Deployment

The production target is **one EC2 instance running Docker Compose** (nginx + Let's
Encrypt, api, worker, web, redis) against an **existing shared Aurora/RDS PostgreSQL**
database (own schema `helpdesk`, own least-privilege role), with **SES** for email and
**S3** for attachments, both through the EC2 instance role.

**The step-by-step runbook is [`deploy/README.md`](../../deploy/README.md).** This page
summarises the design and the rules that apply to any environment.

## Topology

```
Internet ── 80/443 ── nginx (TLS, single hostname)
                        ├─ /api/*, /socket.io/*  → api:4000  (NestJS, Socket.IO /rt and /chat)
                        └─ everything else       → web:3000  (Next.js standalone)
api, worker ── redis (internal, password, AOF — never published)
api, worker ── Aurora writer endpoint (schema helpdesk, sslmode=require)
api, worker ── SES API + S3 bucket (instance role; IMDSv2 hop limit 2)
```

One hostname means host-only cookies (the refresh cookie is scoped to
`/api/v1/auth`), no CORS in practice, and websockets on the same origin. Provider
webhooks arrive at `https://<domain>/api/v1/webhooks/<channel>/<secret>`
(`PUBLIC_API_URL` = the domain).

## Images

| Image | Dockerfile | Build context | Notes |
|---|---|---|---|
| `digisoft-api` | `backend/api/Dockerfile` | `backend/` | Also the migrate job: keeps pnpm + a Prisma CLI pinned to the lockfile's `@prisma/client` version |
| `digisoft-worker` | `backend/worker/Dockerfile` | `backend/` | No HTTP port |
| `digisoft-web` | `frontend/Dockerfile` | `frontend/` | `output: 'standalone'`; `NEXT_PUBLIC_API_URL` is a **required build arg** |

All three: multi-stage, `pnpm@10.33.0` installed with npm (not corepack),
`pnpm install --frozen-lockfile`, pruned to production dependencies, run as the
non-root `node` user with code owned by root (read-only to the app). The api image has
a `HEALTHCHECK` on `/api/v1/health/live` (falling back to `/api/v1/health`); compose
uses `/api/v1/health` (checks Postgres + Redis) for readiness.

```bash
docker build -f backend/api/Dockerfile    -t digisoft-api    backend
docker build -f backend/worker/Dockerfile -t digisoft-worker backend
docker build -t digisoft-web --build-arg NEXT_PUBLIC_API_URL=https://desk.example.com/api/v1 \
  --build-arg NEXT_PUBLIC_SOCKET_URL=https://desk.example.com frontend
```

`deploy/docker-compose.prod.yml` builds all three from these contexts.

## Release order

1. `bash deploy/scripts/check-migrations.sh` — fails on any migration that would touch
   something outside schema `helpdesk` (`public.` references, `CREATE EXTENSION`,
   `search_path`, role/database DDL, GRANT/REVOKE).
2. `docker compose -f deploy/docker-compose.prod.yml --profile migrate run --rm migrate`
   — `prisma migrate deploy`, once, as its own step. The API **never** migrates on
   boot in production (the dev `backend/docker-compose.yml` still does, for convenience).
3. `up -d` api, worker, web (nginx and certbot stay up).

`deploy/scripts/deploy.sh` does all of this. Migrations are forward-only; review each.

> **Never** run `prisma migrate dev`, `prisma migrate reset`, `prisma db push` or the
> seed against the shared Aurora database. `reset` drops the schema; `dev`/`push`
> can generate destructive changes. Only `migrate deploy` is allowed there.

## Before going live

- [ ] `deploy/.env` filled from `deploy/.env.example`; no `replace-me` left (`deploy.sh` checks).
- [ ] `NODE_ENV=production` — the API then **refuses to boot** with `COOKIE_SECURE=false`, localhost URLs, `EMAIL_PROVIDER=console`, a missing `CHANNEL_ENCRYPTION_KEY`, or placeholder/identical JWT secrets.
- [ ] `DATABASE_URL` has `?schema=helpdesk&sslmode=require&connection_limit=10` and the `helpdesk_app` role (`deploy/sql/01-create-role-and-schema.sql`).
- [ ] `TRUST_PROXY=1` (nginx is one hop), so `req.ip` and rate limits see the real client.
- [ ] Instance role attached, IMDSv2 hop limit 2, SES domain verified with DKIM, SES production access granted, S3 bucket private.
- [ ] `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` absent (not empty) so the SDK uses the instance role.
- [ ] Registered in Workeasy360 (`connect_product_sso --product easy_helpdesk`) and the `WORKEASY360_*` values set for **api and worker** ([docs/workeasy360-sso.md](../../docs/workeasy360-sso.md)); with `WORKEASY360_SSO_ONLY` on (the production default) both refuse to boot without them.
- [ ] An organization that already exists attached with `link-workeasy360-organization` **before** its first Workeasy360 sign-in. Otherwise: first organization registered, then `ALLOW_PUBLIC_REGISTRATION=false` (registration is refused anyway while SSO-only).
- [ ] `CHANNEL_ENCRYPTION_KEY` backed up somewhere other than the instance.
- [ ] Aurora automated backups / PITR confirmed with the database owner.

## Scaling notes

- Socket.IO uses the Redis adapter, so API instances share rooms and a client can connect to any of them.
- BullMQ workers are horizontally scalable; queue concurrency is `WORKER_CONCURRENCY` per process.
- Rate-limit counters are per API process; move them to Redis before running more than one API instance.
- Beyond one host: ElastiCache for Redis, an ALB in front (keep `TRUST_PROXY` equal to the number of proxy hops), S3 already shared.
- Reporting reads daily rollup tables rather than scanning tickets (see `PHASE-7-PLAN.md`).
