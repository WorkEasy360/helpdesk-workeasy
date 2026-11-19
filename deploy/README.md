# Production deployment — single EC2 host

Everything in this directory deploys the help desk to **one EC2 instance running Docker
Compose**, in front of an **existing shared Aurora/RDS PostgreSQL** database, with
**SES** for email and **S3** for attachments.

```
                     Internet
                        |  80 / 443 (only published ports)
                   +---------+
                   |  nginx  |  TLS (Let's Encrypt), https://DOMAIN
                   +---------+
        /api/*, /socket.io/*  |   everything else
              +---------------+---------------+
              v                               v
         api :4000  <---- redis (internal, ---> web :3000 (Next.js)
              |          password, AOF)
         worker ---------------^
              |
   Aurora writer endpoint :5432  (schema "helpdesk", role helpdesk_app, TLS)
   SES API (email)  ·  S3 bucket (attachments/exports)  — via the EC2 instance role
```

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | redis, api, worker, web, nginx, certbot + the one-off `migrate` job |
| `.env.example` | Every variable, with production defaults. Copy to `.env` |
| `nginx/templates/default.conf.template` | Single-hostname routing, websockets, TLS |
| `scripts/bootstrap-ec2.sh` | Docker + Compose + git on Ubuntu / Amazon Linux 2023, swap on small hosts |
| `scripts/init-letsencrypt.sh` | First certificate (renewal is automatic afterwards) |
| `scripts/deploy.sh` | Preflight → build → migrate → up → health wait → prune |
| `scripts/check-migrations.sh` | Fails if a migration would touch anything outside schema `helpdesk` |
| `sql/01-create-role-and-schema.sql` | Least-privilege role + own schema in the shared database |
| `iam/helpdesk-ec2-policy.json` | Instance-role policy: SES send + S3 object access, nothing else |

> **The shared database is not ours.** Only ever run `prisma migrate deploy` against it
> (that is all the `migrate` service does). **Never** run `prisma migrate dev`,
> `prisma migrate reset`, `prisma db push` or `pnpm db:seed` against Aurora — `reset`
> drops the schema, `dev`/`push` can generate destructive changes and need a shadow
> database. Those are for local Postgres only.

---

## 1. AWS prerequisites (console or CLI, once)

**EC2 instance.** Ubuntu 24.04 or Amazon Linux 2023, x86_64 or arm64. `t3.medium`
(4 GB) is comfortable; `t3.small` (2 GB) works — the bootstrap adds 2 GB swap and
images build one at a time. 30 GB gp3 root volume. Allocate an **Elastic IP** and
attach it, so DNS survives stop/start. Same VPC as the Aurora cluster.

**Security groups.**

| Group | Inbound rule | Source |
|---|---|---|
| EC2 SG (`helpdesk-ec2`) | 22/tcp (SSH) | your admin IP `/32` only |
| | 80/tcp, 443/tcp | `0.0.0.0/0` (and `::/0` if you use IPv6) |
| Aurora SG (existing) | **add** 5432/tcp | the EC2 SG (`helpdesk-ec2`) — reference the group, not an IP |

Outbound: default allow-all (needs SES, S3, Let's Encrypt, Docker Hub, npm, GitHub).

**IAM role for the instance.** Create a role for EC2, attach a policy from
`iam/helpdesk-ec2-policy.json` (replace `REGION`, `ACCOUNT_ID`, the SES domain and the
bucket name), and attach the role to the instance (*Actions → Security → Modify IAM
role*). No access keys anywhere — both SDKs pick up the role automatically.

**IMDSv2 hop limit = 2 (required).** Containers are one network hop further from the
metadata service than the host; with the default limit of 1 the SDK inside Docker
cannot fetch role credentials and SES/S3 calls fail with "Could not load credentials".

```bash
aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 \
  --http-put-response-hop-limit 2 --http-tokens required --http-endpoint enabled
```

**S3 bucket.** Private, in the same region: *Block all public access* ON, ACLs disabled
(bucket owner enforced), default SSE-S3 encryption, versioning optional. **No CORS
configuration is needed**: uploads go browser → API → S3 (never direct to S3), and
downloads are a 302 from the API to a short-lived presigned GET URL that the browser
simply navigates to (a navigation, not a cross-origin fetch).

**SES.**
1. *Verified identities → Create identity → Domain* (e.g. `example.com`), Easy DKIM
   (RSA 2048). Add the three DKIM CNAMEs to DNS; wait for "Verified".
2. Custom MAIL FROM domain (e.g. `mail.example.com`): add the MX record
   (`feedback-smtp.<region>.amazonses.com`) and SPF TXT (`v=spf1 include:amazonses.com ~all`)
   SES shows. This aligns SPF for DMARC.
3. Add a DMARC record if the domain has none: `_dmarc.example.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com"`.
4. **Request production access** (*Account dashboard → Request production access*).
   Until granted, SES is in the sandbox and only delivers to verified addresses —
   invitations and password resets to real users silently won't arrive.
5. `EMAIL_FROM` in `.env` must be an address on the verified domain.

**Database role and schema.** Needs someone with the RDS master user (or
`rds_superuser` / `CREATEROLE`). Pick the existing database name (`<existing_db>`)
and a password without URL-special characters (`openssl rand -hex 24`). From the EC2
host, once Docker is installed (step 2):

```bash
cd ~/Digisoft-Desk/deploy
docker run --rm -it -v "$PWD/sql:/sql:ro" postgres:16-alpine \
  psql "host=<writer-endpoint> port=5432 dbname=<existing_db> user=<admin> sslmode=require" \
       -v pw='<helpdesk_app password>' -v db='<existing_db>' \
       -f /sql/01-create-role-and-schema.sql
```

This creates role `helpdesk_app` and schema `helpdesk` (owned by it), sets the role's
`search_path`, grants CONNECT on the database — and changes nothing else (see the
comments in the SQL for what it deliberately does not do, e.g. no REVOKE on `public`).
Aurora requires TLS-capable clients; `sslmode=require` works with Prisma out of the box.
To also verify the server certificate, mount the RDS CA bundle
(`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`) and use
`sslmode=verify-full&sslrootcert=/path/global-bundle.pem`.

**DNS.** An `A` record for `DOMAIN` (e.g. `desk.example.com`) → the Elastic IP.

## 2. Connect and bootstrap the host

From Windows (PowerShell), the key file must be private or ssh refuses it:

```powershell
icacls .\helpdesk.pem /inheritance:r
icacls .\helpdesk.pem /grant:r "$($env:USERNAME):(R)"
ssh -i .\helpdesk.pem ubuntu@<elastic-ip>        # Amazon Linux: ec2-user@<elastic-ip>
```

On the instance:

```bash
git clone <repo-url> ~/Digisoft-Desk && cd ~/Digisoft-Desk
git checkout <release-branch-or-tag>
sudo bash deploy/scripts/bootstrap-ec2.sh
exit            # log back in so the docker group applies
```

## 3. Configure

```bash
cd ~/Digisoft-Desk/deploy
cp .env.example .env && chmod 600 .env
openssl rand -hex 32        # REDIS_PASSWORD
openssl rand -base64 48     # JWT_SECRET
openssl rand -base64 48     # JWT_REFRESH_SECRET (different)
openssl rand -base64 32     # CHANNEL_ENCRYPTION_KEY — back this one up; losing it loses channel credentials
nano .env                   # DOMAIN, LETSENCRYPT_EMAIL, DATABASE_URL, AWS_REGION, EMAIL_FROM, S3_BUCKET, S3_REGION
```

`deploy.sh` refuses to run while any `replace-me` / `example.com` placeholder remains,
if `DATABASE_URL` lacks `?schema=helpdesk`, or if an empty `S3_ENDPOINT=` /
`S3_ACCESS_KEY=` line is present (remove those lines — an empty value is not "unset").

## 4. TLS certificate (first time only)

DNS must already resolve to the instance and ports 80/443 must be open.

```bash
bash scripts/init-letsencrypt.sh              # STAGING=1 first if you want a dry run
```

Renewal: the `certbot` service runs `certbot renew` every 12 h and nginx reloads every
6 h, so renewed certificates are picked up with no action.

## 5. Deploy (first time and every release)

```bash
cd ~/Digisoft-Desk && git pull
bash deploy/scripts/deploy.sh
```

It runs `check-migrations.sh`, builds `digisoft-{api,worker,web}:<git sha>`, runs the
one-off migration (`docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate`
→ `prisma migrate deploy` into schema `helpdesk`), starts everything, waits for the API
health check and prunes dangling images. Migrations run **once per release as a
separate step**, never on API boot, so a restart can't race a migration.
`SKIP_MIGRATE=1` for a code-only release.

Check: `https://DOMAIN` loads, `https://DOMAIN/api/v1/health` returns
`{"status":"ok",...}`.

### Deploying from GitHub (recommended for small instances)

`.github/workflows/deploy.yml` runs on every push to `main` (or by hand from the
Actions tab). It builds the three images on GitHub, pushes them to GHCR as
`ghcr.io/<owner>/helpdesk-{api,worker,web}:<commit sha>`, copies `deploy/` and the
Prisma migrations to `~/helpdesk` on the host, and runs
`PULL=1 bash scripts/deploy.sh` there (pull → migrate → up → health check). The host
never builds and never holds source code; `deploy/.env` stays only on the host.

One-time setup:

1. **Deploy key**: generate a key used only by GitHub
   (`ssh-keygen -t ed25519 -N "" -f helpdesk-github-deploy`) and append the `.pub` to
   `~/.ssh/authorized_keys` on the host.
2. **Repository secrets** (Settings → Secrets and variables → Actions → Secrets):
   `EC2_HOST` (Elastic IP), `EC2_USER` (`ubuntu`), `EC2_SSH_KEY` (the whole private
   key file, including the BEGIN/END lines).
3. **Repository variable** (same page → Variables): `DOMAIN`, the public hostname.
   It is baked into the web bundle, so changing it means re-running the workflow.
4. **Security group**: GitHub-hosted runners have no fixed IPs, so port 22 must accept
   them (0.0.0.0/0). Password login is off on the host; only keys work.

The workflow authenticates the host to GHCR with its own short-lived token for the
duration of the rollout, so no registry credentials are stored on the host. Roll back
by re-running the workflow for an older commit (Actions → Deploy → the old run →
Re-run), or on the host: `IMAGE_TAG=<sha> docker compose -f docker-compose.prod.yml up -d api worker web`
(the images of recent releases stay on the host).

## 6. First organization

**Signing in through Workeasy360 (production default).** Agents sign in with Workeasy360 and
password sign-in, registration and invitations are off: register the integration in
Workeasy360, set the `WORKEASY360_*` values in `.env` (the api and worker refuse to start
without them), and the first person to sign in from a new Workeasy360 organization creates
its Help Desk organization and becomes its Super Admin. To attach an organization that
already exists, run `link-workeasy360-organization` first. Everything is in
[docs/workeasy360-sso.md](../docs/workeasy360-sso.md); nginx needs no change.

Only with `WORKEASY360_SSO_ONLY=false`:

1. With `ALLOW_PUBLIC_REGISTRATION=true` (the template default), open
   `https://DOMAIN/register` and create your organization and owner account.
2. Then lock registration so nobody else can create an organization on your instance:
   set `ALLOW_PUBLIC_REGISTRATION=false` in `.env` and
   `docker compose -f docker-compose.prod.yml up -d api`.
3. Invite agents from *Settings → Users*. Invitations go out through SES (production
   access required — see step 1).

Do not use `pnpm db:seed` in production: it creates a `demo` organization with a
well-known password, needs dev tooling that the production image doesn't ship, and is
exactly the kind of command that must never point at the shared database.

## Operating

```bash
cd ~/Digisoft-Desk/deploy
C="docker compose -f docker-compose.prod.yml"
$C ps                                   # status + health
$C logs -f --tail=200 api worker        # JSON logs, rotated (10 MB x 5 per container)
$C restart worker
IMAGE_TAG=<previous sha> $C up -d api worker web   # roll back code (schema changes are forward-only)
```

- **Redis** holds queues and the permission cache only (AOF on the `redis-data`
  volume); it is not a system of record. It is never published on a host port.
- **Backups** are Aurora's (automated backups / PITR on the cluster) plus S3
  versioning if enabled. The EC2 host is stateless apart from Redis and certificates.
- **Scaling beyond one host**: move Redis to ElastiCache, put an ALB in front, and
  note rate-limit counters are per API process today (see `backend/docs/ENVIRONMENT.md`).

## Two hostnames instead (not recommended)

Single hostname keeps cookies host-only and needs no CORS. If you must split
(`app.example.com` + `api.example.com`): add a second `server` block in the nginx
template for the API host (both certificates via `-d` flags in init-letsencrypt),
build web with `NEXT_PUBLIC_API_URL=https://api.example.com/api/v1` and
`NEXT_PUBLIC_SOCKET_URL=https://api.example.com`, set `FRONTEND_URL=https://app.example.com`,
`BACKEND_URL`/`PUBLIC_API_URL=https://api.example.com`, and
`COOKIE_DOMAIN=.example.com` — and edit the derived values in `docker-compose.prod.yml`.
