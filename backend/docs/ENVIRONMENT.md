# Environment variables

For development, `backend/.env` is read by the API and worker (`backend/.env.example`
lists the full set with safe defaults) and `frontend/.env.local` by the web app. For
production, `deploy/.env` (template: `deploy/.env.example`) is the single source for
the Docker Compose stack; `backend/.env.production.example` lists the same app
variables for other runtimes. See [`deploy/README.md`](../../deploy/README.md). The API validates its environment at boot with a Zod schema
(`backend/api/src/config/env.schema.ts`) and **refuses to start** on anything missing or
malformed, so a misconfiguration fails immediately instead of at the first request.

Never commit a real `.env`. It is in `.gitignore`.

## Production-only (deploy/.env, read by docker-compose.prod.yml)

| Variable | Notes |
|---|---|
| `DOMAIN` | The public hostname. `FRONTEND_URL`, `BACKEND_URL`, `PUBLIC_API_URL` and the web build args are derived from it |
| `LETSENCRYPT_EMAIL` | Certificate expiry notices |
| `REDIS_PASSWORD` | `openssl rand -hex 32`; used for `requirepass` and `REDIS_URL` |
| `IMAGE_TAG` | Image tag; `deploy.sh` uses the git short sha |
| `APP_VERSION` | Passed to the web build as `NEXT_PUBLIC_APP_VERSION` |

## Core

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `4000` | API listen port |
| `API_PREFIX` | no | `api/v1` | Also fixes the refresh cookie path |
| `LOG_LEVEL` | no | `info` | `silent` … `trace` |
| `FRONTEND_URL` | no | `http://localhost:3000` | CORS origin and the base of emailed links |
| `BACKEND_URL` | no | `http://localhost:4000` | Used in outbound integrations |

## Datastores

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL connection string. Production (shared Aurora): `postgresql://helpdesk_app:PW@<writer-endpoint>:5432/<existing_db>?schema=helpdesk&sslmode=require&connection_limit=10` — own schema, least-privilege role, TLS, bounded pool per process. URL-encode special characters in the password |
| `REDIS_URL` | no (`redis://localhost:6379`) | Cache, queues and the Socket.IO adapter. Production: `redis://:<REDIS_PASSWORD>@redis:6379`, built by `deploy/docker-compose.prod.yml` from `REDIS_PASSWORD` |

## Authentication

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | **yes** | — | ≥ 32 characters. `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | no | `15m` | Access token lifetime (`30s`, `15m`, `2h`, `7d`) |
| `JWT_REFRESH_SECRET` | **yes** | — | ≥ 32 characters, different from `JWT_SECRET`. Also keys the HMAC for refresh, reset and invite tokens — rotating it invalidates all of them |
| `JWT_REFRESH_EXPIRES_IN_DAYS` | no | `30` | Refresh token lifetime |
| `COOKIE_SECURE` | no | `false` | **Set to `true` in production** |
| `COOKIE_DOMAIN` | no | — | e.g. `.digisoft360.com` when the API and frontend share a parent domain |

## Proxy, request limits and registration (added in this hardening pass)

| Variable | Default | Production | Notes |
|---|---|---|---|
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | `1` | Express `trust proxy`: which hops may set `X-Forwarded-For`/`-Proto`, deciding `req.ip` (rate limits, audit) and `req.protocol` (Twilio signature URLs). A hop count, `true`/`false`, or a list of addresses/CIDRs. nginx is exactly one hop |
| `BODY_LIMIT` | `1mb` | `1mb` | JSON / form body ceiling. Attachments (multipart) are capped by `ATTACHMENT_MAX_BYTES` instead |
| `WEBHOOK_BODY_LIMIT` | `ATTACHMENT_MAX_BYTES` × 1.4 + 1 MB | unset | Inbound channel webhooks, which may carry base64 attachments. nginx's `client_max_body_size` (40m) must stay above it |
| `ALLOW_PUBLIC_REGISTRATION` | `true` | `false` after the first organization | When `false`, `POST /auth/register` (creating a new organization) is refused |

With `NODE_ENV=production` the API also refuses to boot on unsafe settings:
`COOKIE_SECURE=false`, localhost `FRONTEND_URL`/`BACKEND_URL`/`PUBLIC_API_URL`,
`EMAIL_PROVIDER=console`, a missing `CHANNEL_ENCRYPTION_KEY`, or placeholder or
identical JWT secrets.

## Rate limiting

| Variable | Default | Notes |
|---|---|---|
| `THROTTLE_TTL_SECONDS` | `60` | Window for the default bucket |
| `THROTTLE_LIMIT` | `300` | Requests per window per client. A single workspace navigation fans out to several endpoints, so this is a per-user-minute budget rather than a page-view count |
| `AUTH_THROTTLE_LIMIT` | `10` | Ceiling for the `auth` bucket |
| `THROTTLE_ENABLED` | `true` | Only the test harness sets this to `false` |

Counters are held in process memory, so limits apply **per API instance**. Moving them
to Redis is required before running more than one instance behind a load balancer.

## Email

| Variable | Notes |
|---|---|
| `EMAIL_PROVIDER` | `console` (logs the message), `smtp`, or `ses` |
| `EMAIL_FROM` | From address on every transactional email |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | Required when `EMAIL_PROVIDER=smtp` |
| `AWS_REGION` | Required when `EMAIL_PROVIDER=ses`; credentials come from the standard AWS provider chain — on EC2, the instance role (containers need IMDSv2 hop limit 2). `EMAIL_FROM` must be on an SES-verified domain |

## Attachment and report storage

`backend/packages/storage` — moved out of the API in Phase 7 so the worker can write report
exports to the same place the API serves attachments from — is shared by both
processes and must be configured identically in both.

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | `local` writes to disk and streams downloads back through the API; `s3` uses any S3-compatible bucket and hands out short-lived signed URLs |
| `STORAGE_LOCAL_PATH` | `./storage` | Only used by the `local` provider. **Set it to an absolute path.** The API and the worker are separate processes with different working directories — a relative path resolves to two different directories, so the worker's report exports would 404 when the API tries to serve them. Put it on a shared, persistent volume (`docker-compose.yml` mounts one), or use `s3` for anything multi-instance |
| `ATTACHMENT_MAX_BYTES` | `26214400` (25 MB) | Enforced by the service and again by the multipart parser |
| `S3_BUCKET`, `S3_REGION` | — | Required when `STORAGE_PROVIDER=s3` |
| `S3_ENDPOINT` | — | Set for MinIO or R2; **omit entirely** for AWS — an empty `S3_ENDPOINT=` line is passed to the SDK as an empty endpoint |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | — | Omit to use the standard AWS provider chain (the EC2 instance role in production) |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO; `false` for AWS. Set it explicitly — keep API and worker identical |
| `S3_SIGNED_URL_TTL_SECONDS` | `300` (API) / `900` (worker) | How long a download link stays valid. The defaults differ between processes, so set it explicitly |

The `local` provider keeps files on one node's disk (or a volume every node mounts), so
it suits development and single-node self-hosting. Anything running more than one API
instance needs `s3`.

## Worker

| Variable | Default | Notes |
|---|---|---|
| `WORKER_CONCURRENCY` | `5` | Jobs processed in parallel per queue (the SLA sweep always runs one at a time) |
| `SLA_SCAN_INTERVAL_SECONDS` | `60` | How often the worker sweeps for SLA warnings and breaches; this is the detection resolution |
| `METRICS_ROLLUP_INTERVAL_SECONDS` | `900` | How often the worker recomputes ticket/agent daily rollups (also runs inline on a stale report request; see Phase 7 below) |
| `METRICS_ROLLUP_DAYS` | `2` | How many recent days each sweep recomputes |

## Frontend

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | **Build time.** e.g. `https://desk.example.com/api/v1`. Inlined into the bundle and the CSP `connect-src`; a required build arg of `frontend/Dockerfile`. Public — never put a secret in a `NEXT_PUBLIC_` variable |
| `NEXT_PUBLIC_SOCKET_URL` | **Build time**, optional. Socket.IO origin (e.g. `https://desk.example.com`); defaults to the API origin. The client connects to namespaces `/rt` and `/chat` on the default `/socket.io/` path |
| `NEXT_PUBLIC_APP_VERSION` | **Build time**, optional. Shown in the app |
| `API_INTERNAL_URL` | **Runtime.** Base URL for server-side fetches from the Next server, e.g. `http://api:4000/api/v1` inside Compose |

## Seed

`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` — used only by `pnpm db:seed` (development; creates a `demo`
organization). Not available in the production image and never run against the shared
database — register the first organization through the UI instead.

## Phase 4 — self-service

Phase 4 introduced no new environment variables. The customer portal is served by the
same Next.js deployment (`/help/<slug>`) and the same API (`/api/v1/portal/<slug>/…`),
so `FRONTEND_URL` is what password-reset and verification links for customers are built
from, and `CORS`/cookie settings are shared with the agent app.

## Phase 5 — channels, webhooks and API keys

| Variable | Default | Meaning |
|---|---|---|
| `CHANNEL_ENCRYPTION_KEY` | — | 32 bytes, base64 or hex (`openssl rand -base64 32`). Encrypts channel credentials at rest. Required before a channel can store credentials — there is deliberately no fallback key. The **worker needs the same value** to decrypt them when it sends. |
| `PUBLIC_API_URL` | `BACKEND_URL` | Public base URL providers post webhooks to; it is what the generated webhook URL is built from. |
| `WEBHOOK_MAX_ATTEMPTS` | `5` | Attempts per outbound webhook delivery before it is marked failed. Set on the worker. |

Outbound email for an email channel uses the deployment's existing `EMAIL_PROVIDER`
settings; the channel supplies the from-address, display name, reply-to and signature.


## Phase 6 — the assistant

Phase 6 introduced no required environment variables: the built-in provider is the
default and needs nothing. Two existing ones matter to it:

- `CHANNEL_ENCRYPTION_KEY` also encrypts the Anthropic API key stored in `AiSettings`,
  so the **worker needs the same value** to run auto-analysis against Anthropic.
- `REDIS_URL` carries the `ai` queue that auto-analysis runs on.

The Anthropic API key **for the per-ticket insights** is per organization and is entered
in the app (Settings → Assistant), not in the environment, so two tenants on one
deployment bill separately and neither key is readable from the API.

### The workspace assistant

The conversational assistant — the chat button on every agent page — is different: it is
a feature of the deployment, so it runs on the operator's own key, from here.

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `HEURISTIC` | `ANTHROPIC`, `GEMINI`, or `HEURISTIC` for the built-in deterministic provider. Case-insensitive |
| `AI_MODEL` | per provider | `claude-opus-5` for Anthropic, `gemini-2.5-flash` for Gemini. Leave unset to take the default |
| `AI_API_KEY` | — | **Required for any provider but `HEURISTIC`.** The API refuses to start without it |

Gemini is called over its REST API with `responseMimeType: application/json`, so the
model returns the assistant's reply object directly. Thinking is turned off
(`thinkingBudget: 0`): on 2.5 models thinking tokens count against the output budget, and
leaving it on can consume the whole allowance and return an empty candidate.

`HEURISTIC` needs nothing: the chat still works, answers from its read-only tools alone,
and tells the agent it has no model behind it. Nothing about the assistant reads
`AiSettings`, and nothing about the insights reads these three.

## Phase 7 — analytics, reporting and CSAT

Phase 7 introduced no required environment variables beyond `STORAGE_LOCAL_PATH` needing
to be absolute now that the worker writes report exports to it (see *Attachment and
report storage* above). `METRICS_ROLLUP_INTERVAL_SECONDS` and `METRICS_ROLLUP_DAYS`
(*Worker*, above) tune the rollup sweep; a report is self-healing regardless of that
schedule, since a request recomputes stale recent days itself before answering.

Satisfaction-survey emails go out through the same `EMAIL_PROVIDER` configuration as
every other email (*Email*, above); the survey link is built from `FRONTEND_URL` and the
organization's help center slug, so an organization needs one for surveys to have
anywhere to send the customer.
