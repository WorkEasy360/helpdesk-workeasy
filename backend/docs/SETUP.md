# Setup

## Requirements

| Tool | Version |
|---|---|
| Node.js | 20 or newer (22 recommended) |
| pnpm | 10 (`corepack enable`) |
| PostgreSQL | 16 (or a managed instance) |
| Redis | 7 |
| Docker | optional, for the one-command stack |

The frontend and backend are separate projects. Backend commands run from `backend/`,
frontend commands from `frontend/`.

## Option A — Docker Compose

```bash
cd backend
cp .env.example .env
# set JWT_SECRET and JWT_REFRESH_SECRET: openssl rand -base64 48
docker compose --profile local-db up --build
```

Starts PostgreSQL, Redis, MinIO, Mailhog, the API and the worker. The API container
applies migrations on boot. Run the frontend separately:

```bash
cd frontend
docker build -t digisoft-frontend .   # NEXT_PUBLIC_* are build args
docker run -p 3000:3000 digisoft-frontend
```

Using a managed database instead? Edit the `DATABASE_URL` line under the `api` and
`worker` services in `docker-compose.yml` to your connection string (not `.env` — the
containers ignore the app's own `DATABASE_URL` in favor of the local `postgres`
service's hostname by design), then drop the profile flag so that service is skipped:

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| Health check | http://localhost:4000/api/v1/health |
| Mail catcher | http://localhost:8025 |
| MinIO console | http://localhost:9001 |

## Option B — Run locally

```bash
corepack enable
cd backend
pnpm install
cp .env.example .env          # then fill in DATABASE_URL and the two JWT secrets

pnpm --filter @digisoft/shared build
pnpm db:generate              # generate the Prisma client
pnpm db:migrate               # create the schema
pnpm db:seed                  # optional demo organization

pnpm dev:api                  # http://localhost:4000
pnpm dev:worker               # background jobs

cd ../frontend
pnpm install
cp .env.example .env.local
pnpm dev                      # http://localhost:3000
```

The seed creates organization `demo` with:

```
admin@digisoft360.local / ChangeMe123!   (Super Admin)
agent@digisoft360.local / ChangeMe123!   (Agent)
```

Override with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. **Change these before any
deployment that is reachable from a network.**

Or skip the seed and create your own organization at http://localhost:3000/register.

Agents sign in with email and password locally (`WORKEASY360_SSO_ONLY` defaults to off
outside production). To rehearse "Continue with Workeasy360", see
[docs/workeasy360-sso.md](../../docs/workeasy360-sso.md#local-development).

## Tests

```bash
# API unit tests (no database needed)
pnpm --filter @digisoft/api test

# API integration tests — needs PostgreSQL and Redis running.
# Create the database once:
createdb digisoft_helpdesk_test
pnpm --filter @digisoft/api test:e2e

# Browser tests (from frontend/) — needs the API and the frontend running
pnpm exec playwright install chromium   # first run only
pnpm test:e2e
```

The integration suites default to
`postgresql://digisoft:digisoft@localhost:5432/digisoft_helpdesk_test`; set
`DATABASE_URL` to point elsewhere. They truncate every table between suites, so never
aim them at a database holding data you want to keep.

On a machine where Chromium is already installed (CI images, sandboxes), point
Playwright at it instead of downloading one:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm test:e2e
```

## Attachments in development

`STORAGE_PROVIDER=local` (the default) writes uploads under `STORAGE_LOCAL_PATH`
(`./storage`, gitignored) and streams downloads back through the API, so no object
store is needed to work on ticketing. Switch to `STORAGE_PROVIDER=s3` with the MinIO
service from Docker Compose, or a real bucket, when you want to exercise that path.

## Everyday commands

```bash
pnpm typecheck        # every backend package (run in frontend/ too)
pnpm build            # every backend package (run in frontend/ too)
pnpm db:migrate       # create and apply a migration in development
pnpm db:deploy        # apply existing migrations (production)
pnpm --filter @digisoft/db studio   # browse the database
```
