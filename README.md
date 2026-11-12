# Digisoft360 Help Desk

A multi-tenant customer support platform: ticketing, SLA, automation, knowledge base,
omnichannel and AI assistance.

**Status: Phases 1–7 implemented.** Authentication, RBAC, organizations, users,
departments, teams, contacts, accounts, the full ticketing core — conversations,
internal comments, attachments, history, the agent workspace — the operations layer —
activities, assignment rules, an automation engine with escalations, SLA with business
hours and a background sweep, blueprint workflows — and self-service: a branded help
center per organization with a knowledge base, web forms, customer accounts, "my
requests" and a moderated community — and omnichannel: email in and out with real
threading, live chat, WhatsApp, Instagram, Messenger, Telegram and telephony adapters,
signed outbound webhooks and API keys — an AI assistant that summarises a
conversation, scores sentiment, classifies intent and drafts a reply grounded in the
knowledge base — and analytics: a dashboard, per-report screens for tickets, agents,
SLA and CSAT, CSV exports rendered in the background, and satisfaction surveys sent on
resolution and answered through a one-time link with no account behind it.

The repo holds two independent projects, each with its own `package.json`, lockfile,
Dockerfile and `.env.example`:

```bash
# backend — API, worker, Postgres, Redis, MinIO, Mailhog
cd backend
cp .env.example .env     # set the two JWT secrets
docker compose --profile local-db up --build

# frontend — in a second terminal
cd frontend
cp .env.example .env.local
pnpm install && pnpm dev
```

Then open http://localhost:3000. Full instructions in [backend/docs/SETUP.md](./backend/docs/SETUP.md).

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind, TanStack Query, Zustand, React Hook Form + Zod |
| Backend | Node.js + NestJS 11, REST `/api/v1`, Socket.IO |
| Database | PostgreSQL 16 via Prisma 6 |
| Background work | BullMQ on Redis, run by a separate worker process |
| Infrastructure | Docker Compose for development; S3-compatible object storage |

## Layout

```
frontend          Next.js app (standalone; frontend/shared is its copy of the API's Zod schemas and types)
backend/api       NestJS API and Socket.IO gateway
backend/worker    BullMQ consumers (email, notifications, automation, SLA sweep, channel sends, webhooks, AI, metric rollups, report exports)
backend/packages/engine  Rule evaluation, actions, business-hours SLA math, assignment, blueprints
backend/packages/channels Channel adapters (verify, parse, send) and credential encryption
backend/packages/ai    Assistant providers (Anthropic, built-in), prompts and the analysis path
backend/packages/analytics Rollups, reports, CSV export and the CSAT survey lifecycle
backend/packages/storage StorageProvider — local filesystem and S3-compatible, shared by the API and worker
backend/packages/db    Prisma schema, migrations, seed, tenant-isolation extension
backend/packages/shared  Zod schemas and types — the source of truth copied into frontend/shared
```

## What is built

- **Multi-tenancy** enforced in the data layer, not in callers: a Prisma client
  extension injects `organizationId` into every query and cross-tenant access returns
  404 rather than 403, so record ids stay unenumerable.
- **Authentication** with Argon2id, short-lived access tokens, and refresh-token
  rotation with reuse detection that revokes the whole session family.
- **RBAC** over a permission catalogue, with five seeded system roles and support for
  custom ones. Permissions are re-resolved per request (Redis-cached), so revoking a
  role takes effect immediately.
- **Organizations, users, departments, teams, contacts, accounts** — full CRUD with
  validation, authorization, audit history and soft deletes.
- **Ticketing** with per-organization sequential numbering allocated inside the
  creation transaction, configurable statuses and priorities (behaviour comes from
  flags, never from a name), assignment, tags, merge, linking and following.
- **Conversations** stored one row per message, with customer replies and internal
  comments as distinct types. Internal comments are filtered out in the database query
  for non-agents and are unmistakable in the UI.
- **Attachments** with a MIME allowlist, size cap and filename sanitisation; metadata in
  PostgreSQL and bytes in storage, behind two real providers (local filesystem, or any
  S3-compatible bucket with signed URLs). Every download is re-authorised.
- **Record-level ticket access**: `ticket.read.all` sees the whole queue; without it an
  agent sees only their assignments, their departments and tickets they follow.
- **Agent workspace**: three-pane queue / conversation / properties layout with saved
  views, filters, search, quick actions and a history timeline.
- **Activities**: tasks, calls and events attached to tickets, contacts and accounts.
- **Assignment rules**: ordered, condition-driven routing to a specific agent, a
  department queue, round-robin, or the least-loaded agent.
- **Automation engine**: trigger + conditions + ordered actions, with every evaluation
  recorded. Escalations are the same rules on the SLA triggers.
- **SLA**: per-priority first-response and resolution targets on a business-hours
  calendar with holidays; the clock pauses in on-hold statuses and a worker sweep raises
  warnings and breaches exactly once.
- **Blueprints**: configurable state machines with required fields and role
  restrictions; a governed ticket can only move along its allowed transitions.
- **Help center**: one customer-facing site per organization at `/help/<slug>`, with its
  own branding and switches for public browsing, sign-up, request submission, the
  knowledge base and the community. Settings take effect immediately.
- **Knowledge base**: categories and Markdown articles with draft/published states and
  three visibility levels, slugs derived from titles, portal search that ranks title
  matches first, view counts and "was this helpful" feedback the author can read.
- **Web forms**: a field builder whose submissions become tickets — routed, given an SLA
  and put through automation like any other ticket — with a honeypot and rate limiting
  instead of a third-party captcha.
- **Customer portal**: customers sign up (reusing the contact an agent already has for
  that address), raise requests, reply with attachments, reopen a resolved request by
  replying, and close their own. They never see an internal comment, and never another
  customer's request.
- **Community**: categories, topics, replies, one-vote-per-person upvotes, accepted
  answers, and an optional moderation queue agents work from the agent app.
- **Email as a real channel**: signed inbound webhooks (generic, Mailgun, Postmark) that
  become tickets — contact resolved, attachments stored, quoted history trimmed,
  auto-replies ignored — and outbound replies carrying `Message-ID`, `In-Reply-To` and
  `References`, so the customer's answer threads back onto the same ticket.
- **Live chat** with its own visitor socket: the conversation is a ticket from the first
  line, agents pick it up from a chat inbox, and the reply reaches the widget instantly.
- **Messaging and telephony adapters**: WhatsApp Cloud, Messenger, Instagram, Telegram
  and Twilio, each verifying the provider's real signature scheme; a call arrives as a
  logged call activity with its recording.
- **Idempotent ingestion**: every delivery is stored before it is interpreted and keyed
  by the provider's message id, so a redelivery changes nothing and a parser bug leaves
  the evidence behind.
- **Outbound webhooks** with per-endpoint signing keys, HMAC signatures over
  `timestamp.body`, retries with backoff, a delivery log and replay.
- **API keys** backed by their own service user and role, so an integration is
  authorised, audited and attributed exactly like a person, and revoking one closes
  every path at once.
- **Analytics and reporting**: a dashboard and four report screens (tickets, agents, SLA,
  CSAT) reading a mix of daily rollup tables and live queries, self-healing if the
  worker's rollup sweep has fallen behind rather than trusting its schedule. A CSV
  export is a queued job the worker renders and writes to the same storage attachments
  use, downloaded through the same re-authorised path.
- **Satisfaction surveys**: resolving a ticket schedules exactly one survey and emails a
  one-time link; the database holds only the link's hash, the public answer page needs
  no account, and a used or expired link is refused.
- **AI assistant** behind a provider interface with two real implementations: Anthropic
  (the official SDK, pinned models, a cached system prompt) and a built-in rule-based
  analyser that needs no credentials and no network. It summarises the conversation,
  scores sentiment, classifies intent into the organization's own categories and
  priorities, and drafts a reply grounded in published knowledge base articles — saying
  so plainly when nothing matched. Internal comments are never sent to a provider, every
  call is stored with its tokens, cost and latency, a monthly token budget is a hard
  stop, and nothing the assistant produces reaches a customer or a ticket field until an
  agent chooses it.
- **Background jobs and realtime**: a worker that sends email, runs automation and
  sweeps SLAs, and an authenticated Socket.IO gateway whose ticket events reach only
  the sockets entitled to that ticket.

## Tests

Backend suites run from `backend/`, the browser suite from `frontend/`.

| Suite | Count | Command |
|---|---|---|
| Engine unit (business hours, conditions, blueprints) | 24 | `pnpm --filter @digisoft/engine test` |
| Channel adapters unit (signatures, parsing, threading hints, encryption) | 32 | `pnpm --filter @digisoft/channels test` |
| Assistant unit (providers, prompts, parsing, retrieval) | 19 | `pnpm --filter @digisoft/ai test` |
| API unit | 73 | `pnpm --filter @digisoft/api test` |
| API integration (auth, tenant isolation, RBAC, rate limiting, tickets, ticket access, attachments, activities, operations, knowledge base, portal, community, channels, chat, integrations, assistant, analytics/CSAT) | 162 | `pnpm --filter @digisoft/api test:e2e` |
| Analytics unit (ranges, CSV quoting, survey tokens) | 16 | `pnpm --filter @digisoft/analytics test` |
| Browser (register, customers, ticket workflow, automation and SLA, help center and community, channels and live chat, assistant, dashboards and reports) | 27 | `pnpm test:e2e` (in `frontend/`) |

## Documentation

| File | Contents |
|---|---|
| [backend/docs/ARCHITECTURE.md](./backend/docs/ARCHITECTURE.md) | System design, multi-tenancy, auth/RBAC, project layout |
| [backend/docs/DATABASE.md](./backend/docs/DATABASE.md) | Entity map, schema, indexing plan |
| [backend/docs/API.md](./backend/docs/API.md) | Endpoint reference, Socket.IO events, error codes |
| [backend/docs/SETUP.md](./backend/docs/SETUP.md) | Running it locally, with or without Docker |
| [backend/docs/ENVIRONMENT.md](./backend/docs/ENVIRONMENT.md) | Every environment variable |
| [backend/docs/DEPLOYMENT.md](./backend/docs/DEPLOYMENT.md) | Production topology and go-live checklist |
| [frontend/docs/FRONTEND.md](./frontend/docs/FRONTEND.md) | Route plan and frontend conventions |
| [frontend/docs/DESIGN-SYSTEM.md](./frontend/docs/DESIGN-SYSTEM.md) | Tokens, `c-*` components, the shell and the page contract |
| [backend/docs/AI-ASSISTANT.md](./backend/docs/AI-ASSISTANT.md) | The workspace assistant: its tools, actions, prompt and safety rules |
| [backend/docs/PHASE-1-PLAN.md](./backend/docs/PHASE-1-PLAN.md) | Phase 1 scope and status |
| [backend/docs/PHASE-2-PLAN.md](./backend/docs/PHASE-2-PLAN.md) | Phase 2 scope, decisions and status |
| [backend/docs/PHASE-3-PLAN.md](./backend/docs/PHASE-3-PLAN.md) | Phase 3 scope, decisions and status |
| [backend/docs/PHASE-4-PLAN.md](./backend/docs/PHASE-4-PLAN.md) | Phase 4 scope, decisions and status |
| [backend/docs/PHASE-5-PLAN.md](./backend/docs/PHASE-5-PLAN.md) | Phase 5 scope, decisions and status |
| [backend/docs/PHASE-6-PLAN.md](./backend/docs/PHASE-6-PLAN.md) | Phase 6 scope, decisions and status |
| [backend/docs/PHASE-7-PLAN.md](./backend/docs/PHASE-7-PLAN.md) | Phase 7 scope, decisions and status |

## Roadmap

1. ~~**Foundation** — workspace, Docker, Prisma, auth, RBAC, organizations, users, departments, contacts, accounts~~ ✅
2. ~~**Core helpdesk** — tickets, statuses, priorities, assignment, conversations, internal comments, attachments, history, agent workspace~~ ✅
3. ~~**Support operations** — activities, assignment rules, automation engine, SLA, escalation, blueprints~~ ✅
4. ~~**Self-service** — knowledge base, help center, customer portal, web forms, community~~ ✅
5. ~~**Omnichannel** — email, live chat, WhatsApp, Instagram, Messenger, Telegram, telephony~~ ✅
6. ~~**AI** — summary, sentiment, intent, suggested reply, KB-grounded answers~~ ✅ (pgvector/RAG later)
7. ~~**Analytics** — dashboards, reports, agent performance, SLA reporting, CSAT~~ ✅
