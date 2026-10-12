# Digisoft360 Help Desk — API Reference and Plan

> Status: endpoints marked **P1**–**P5** are **implemented and tested**. Everything else
> is planned for the phase noted beside it and is not reachable yet.

Base path `/api/v1`. All responses use the envelope:

```json
{ "success": true, "data": { }, "meta": { "page": 1, "pageSize": 25, "total": 0 } }
{ "success": false, "error": { "code": "TICKET_NOT_FOUND", "message": "Ticket not found" } }
```

List endpoints share `?page&pageSize&sort&order&q&<filters>` and are cursor-capable where volume demands it. Every route except `@Public()` ones requires a bearer access token and is checked by `PermissionsGuard`.

## Auth — P1 (implemented)
```
GET    /auth/methods                  # { password, workeasy360, workeasy360SignOut } — which ways in are offered
GET    /auth/register                 # { enabled } — whether self-serve signup is on (false when SSO-only)
POST   /auth/register                 # creates org + super admin; 403 REGISTRATION_DISABLED
                                      # when ALLOW_PUBLIC_REGISTRATION=false
POST   /auth/login                    # 403 PASSWORD_SIGN_IN_DISABLED when WORKEASY360_SSO_ONLY
POST   /auth/refresh                  # refresh cookie -> new access token (rotates)
POST   /auth/logout
GET    /auth/me
PATCH  /auth/me                       # { firstName?, lastName?, phone?, avatarUrl? } — own profile only
POST   /auth/forgot-password
POST   /auth/reset-password
POST   /auth/verify-email
POST   /auth/resend-verification

# Sign in with Workeasy360 — browser redirects, OUTSIDE the /api/v1 prefix (see docs/workeasy360-sso.md)
GET    /api/auth/workeasy360/start    # ?organization=<uuid>&next=<path> -> 302 to Workeasy360
GET    /api/auth/callback/workeasy360 # ?code&state -> 302 to the app (session) or /login?sso_error=<code>
GET    /api/auth/workeasy360/logout   # 302 to Workeasy360's end-session endpoint; changes nothing locally

# Errors added by Workeasy360 access checks (HTTP 403): PASSWORD_SIGN_IN_DISABLED,
# WORKEASY360_ACCESS_ENDED (details.reason), WORKEASY360_READ_ONLY, WORKEASY360_ACCESS_UNVERIFIED,
# HELP_CENTER_UNAVAILABLE (portal routes of an organization whose access ended)
POST   /auth/change-password          # change own password; revokes every session
```

## Organization — P1 (implemented)
```
GET    /organizations/current
PATCH  /organizations/current
GET    /organizations/current/business-hours
POST   /organizations/current/business-hours
PATCH  /organizations/current/business-hours/:id
POST   /organizations/current/business-hours/:id/holidays
DELETE /organizations/current/holidays/:id
```

## Users, roles, permissions, departments, teams — P1 (implemented)
```
GET|POST        /users
GET|PATCH|DELETE /users/:id
POST            /users/invite
PATCH           /users/:id/roles
PATCH           /users/:id/departments
POST            /users/:id/activate | /deactivate

GET|POST        /roles
GET|PATCH|DELETE /roles/:id
GET             /permissions

GET|POST        /departments
GET|PATCH|DELETE /departments/:id
GET|POST        /teams
GET|PATCH|DELETE /teams/:id
PATCH           /teams/:id/members
```

## Contacts & accounts — P1 (implemented)
```
GET|POST        /contacts
GET|PATCH|DELETE /contacts/:id
GET             /contacts/:id/tickets        # P2
GET             /contacts/:id/activities     # P3
POST            /contacts/import             # P2

GET|POST        /accounts
GET|PATCH|DELETE /accounts/:id
GET             /accounts/:id/contacts
GET             /accounts/:id/tickets        # P2
```

## Tickets — P2 (implemented)
```
GET    /tickets                       # ?page&pageSize&q&sort&order plus the filters below
GET    /tickets/summary               # counts behind the saved views
GET    /tickets/:id
POST   /tickets
PATCH  /tickets/:id                   # only the fields sent are changed
DELETE /tickets/:id                   # soft delete
POST   /tickets/bulk                  # { ticketIds (1–100), action, payload } — see below

POST   /tickets/:id/assign            # { assignedAgentId?, departmentId? }
POST   /tickets/:id/status            # { statusId, resolutionNote? }
POST   /tickets/:id/priority          # { priorityId }
POST   /tickets/:id/resolve           # { resolutionNote } — required
POST   /tickets/:id/close
POST   /tickets/:id/reopen
PATCH  /tickets/:id/tags              # { tagIds } replaces the set
POST   /tickets/:id/merge             # { targetTicketId, comment? }
POST   /tickets/:id/links             # { linkedTicketId, type }
DELETE /tickets/:id/links/:linkId
POST   /tickets/:id/follow | /unfollow
GET    /tickets/:id/history           # from the audit trail

GET    /tickets/:id/messages          # internal comments filtered out for non-agents
POST   /tickets/:id/messages          # public reply     (ticket.reply)
POST   /tickets/:id/comments          # internal comment (ticket.comment)

POST   /tickets/:id/attachments       # multipart upload, validated and stored
GET    /tickets/:id/attachments
GET    /attachments/:id/download      # streamed (local) or 302 to a signed URL (S3);
                                      # ?mode=url or Accept: application/json -> link as JSON
DELETE /attachments/:id

GET|POST         /ticket-statuses    · PATCH|DELETE /ticket-statuses/:id
GET|POST         /ticket-priorities  · PATCH|DELETE /ticket-priorities/:id
GET|POST         /ticket-categories  · PATCH|DELETE /ticket-categories/:id
GET|POST         /tags               · DELETE       /tags/:id
```

**List filters:** `statusId`, `priorityId`, `departmentId`, `assignedAgentId`, `categoryId`,
`contactId`, `accountId`, `tagId`, `source`, plus the saved-view shortcuts `assignedToMe`,
`unassigned` and `open` (neither resolved nor closed). `q` matches the subject, the
description or a ticket number. Also:

- `createdFrom` / `createdTo` — a date (`2026-01-31`) or ISO 8601 timestamp. Both ends are
  inclusive; a bare `createdTo` date covers that whole UTC day.
- `overdue=true` — open (neither resolved nor closed) tickets whose `dueAt` (the
  resolution due time) has passed.
- `statusCategory=open|resolved|closed` — by status flags: `open` = neither flag,
  `resolved` = `isResolved` and not `isClosed`, `closed` = `isClosed`.

All filters combine (AND).

**Bulk actions** — `POST /tickets/bulk` (`ticket.update`; `assign`/`unassign` also need
`ticket.assign`, checked for the whole request → 403 `PERMISSION_DENIED`):

| `action`     | `payload`                                            |
|--------------|------------------------------------------------------|
| `assign`     | `{ assignedAgentId?, departmentId? }` (at least one) |
| `unassign`   | none — clears the agent, keeps the department        |
| `status`     | `{ statusId, resolutionNote? }`                      |
| `resolve`    | `{ resolutionNote }`                                 |
| `close`      | none                                                 |
| `reopen`     | none                                                 |
| `priority`   | `{ priorityId }`                                     |
| `addTags`    | `{ tagIds }` (1–50) — added to each ticket's set     |
| `removeTags` | `{ tagIds }` (1–50) — removed from each ticket's set |

Each ticket runs through the same code as its single-ticket endpoint, one after another,
so visibility, blueprints, the resolution-note rule (moving to a resolving status without
a note fails for tickets that have none), history, SLA, notifications and automation all
apply. A malformed request is a 400; otherwise the answer is 200 with per-ticket results:

```
{ "action": "status", "succeeded": 1, "failed": 1,
  "results": [ { "id": "…", "ok": true },
               { "id": "…", "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "…" } } ] }
```

A ticket in another organization, or one the caller cannot see, fails with
`TICKET_NOT_FOUND`. Duplicate ids are processed once.

**Download as a link** — `GET /attachments/:id/download?mode=url` (or any request whose
`Accept` includes `application/json`; the portal route
`/portal/:slug/tickets/attachments/:id/download` behaves the same) runs the same
authorisation and answers `{ url, fileName, mimeType, fileSize, expiresAt, direct }`
with `Cache-Control: no-store`. With S3 `url` is the pre-signed link, `expiresAt` its
expiry (`S3_SIGNED_URL_TTL_SECONDS`) and `direct: true`. With local storage there is
nothing to sign: `url` is this API route itself (path only, without the query),
`expiresAt` is null and `direct: false` — fetch it with the same bearer token. Without
the flag the behaviour is unchanged (302 / stream).

## Activities — P3 (implemented)
```
GET    /activities                    # ?type&status&ticketId&contactId&accountId&assignedToId&assignedToMe&overdue&q
GET    /activities/:id
POST   /activities                    # { type: TASK|CALL|EVENT, subject, ... }
PATCH  /activities/:id                # includes { status: OPEN|COMPLETED|CANCELLED }
DELETE /activities/:id                # soft delete
```
A call logged with a duration is stored as already completed. An event needs `startAt`.

## Support operations — P3 (implemented)
```
GET|POST         /assignment-rules   · PATCH|DELETE /assignment-rules/:id
PATCH            /assignment-rules/reorder            # { ids } — full evaluation order

GET              /automation-rules?escalations=true|false
GET              /automation-rules/runs               # ?ruleId&ticketId&matched — every evaluation
GET|POST         /automation-rules   · PATCH|DELETE /automation-rules/:id
POST             /automation-rules/:id/enable | /disable

GET|POST         /sla-policies       · PATCH|DELETE /sla-policies/:id   (PATCH takes the full policy)
GET|POST         /blueprints         · PATCH|DELETE /blueprints/:id     (PATCH takes the full blueprint)

GET    /tickets/:id/transitions        # { governed, blueprint?, transitions[] } for the caller's roles
```

**Escalations are automation rules** whose trigger is `SLA_WARNING` or `SLA_BREACHED`;
there is no separate escalation resource. `?escalations=true` lists just those.

**Rule DSL** (shared by assignment rules, automation rules, SLA policies and blueprints):
conditions are `{ all: Leaf[], any: Leaf[] }` with `Leaf = { field, op, value? }` over
`statusId · priorityId · departmentId · categoryId · assignedAgentId · contactId ·
accountId · source · tagIds · subject · description · contactIsVip · isAssigned ·
priorityWeight` and operators `eq neq in not_in contains not_contains is_empty
is_not_empty gt gte lt lte`. Actions: `assign_agent · assign_department · unassign ·
set_priority · set_status · add_tag · remove_tag · apply_sla · notify_users ·
notify_assignee · notify_department · send_email · add_internal_note · create_task`.
Messages accept `{{ticket.number}} {{ticket.subject}} {{ticket.status}}
{{ticket.priority}} {{contact.name}} {{assignee.name}} {{organization.name}}`.

**Ticket SLA fields** (on every ticket payload): `slaPolicy`, `firstResponseDueAt`,
`resolutionDueAt`, `firstResponseBreachedAt`, `resolutionBreachedAt`, `slaPausedAt`;
`dueAt` mirrors `resolutionDueAt`.

**Query booleans** are parsed strictly: `true|false|1|0`. Anything else is a 400.

## Self-service — P4 (implemented)

### Knowledge base (agent side)
```
GET|POST /kb/categories             · PATCH|DELETE /kb/categories/:id
GET      /kb/articles               # ?categoryId&status&visibility&authorId&mine&q&sort
GET|POST /kb/articles               · PATCH|DELETE /kb/articles/:id
POST     /kb/articles/:id/publish | /unpublish
GET      /kb/articles/:id/feedback  # what readers said, newest first
```
`kb.read` to read, `kb.manage` to write. A slug is derived from the title when one is
not supplied and made unique per organization (`how-to-x`, `how-to-x-2`, …); deleting a
category or article releases its slug for reuse. `visibility` is `PUBLIC` (anyone),
`PORTAL_USERS` (signed-in customers) or `AGENTS_ONLY`, and an article inside a hidden
category is hidden with it. `status` is `DRAFT · PENDING_REVIEW · PUBLISHED · ARCHIVED`;
only `PUBLISHED` is ever served to the portal, and `publishedAt` is stamped once.

### Help center settings and web forms (agent side)
```
GET      /help-center               · PATCH /help-center
GET      /help-center/slug-suggestion?preferred=
GET|POST /web-forms                 · GET|PATCH|DELETE /web-forms/:id
```
`portal.read` to read, `portal.manage` to change. The help center carries the portal
address (unique across the platform), branding and the switches that decide what the
site offers: `isPublished · allowPublicBrowsing · allowSelfRegistration ·
allowTicketSubmission · kbEnabled · communityEnabled · moderateCommunity`. Changes take
effect immediately — the portal's slug cache is dropped on write.

A web form's `fields` are `{ key, label, type, required, placeholder, helpText,
options, mapsTo }` where `type` is `TEXT · TEXTAREA · EMAIL · PHONE · NUMBER · SELECT ·
CHECKBOX · DATE` and `mapsTo` is `subject · description · name · email · phone ·
custom`. Exactly one field must map to `description`; unmapped values are stored on the
ticket's `customFields`.

### Community moderation (agent side)
```
GET|POST /community/categories      · PATCH|DELETE /community/categories/:id
GET      /community/topics          # ?categoryId&type&status&moderation&mine&unanswered&q
GET      /community/topics/:id      · DELETE /community/topics/:id
PATCH    /community/topics/:id/moderate   # { moderation, status, isPinned, isLocked, categoryId }
POST     /community/topics/:id/replies    # an agent answering in public
PATCH    /community/replies/:id/moderate  # { moderation, isAnswer }
DELETE   /community/replies/:id
```
All of it requires `community.moderate`.

### Customer portal — `/portal/:slug/…` (no agent token)
Every route below is public to the platform guard; `PortalGuard` then applies the help
center's own rules. A bearer token from a different organization is refused with 403, a
help center that is not published answers 404, and with `allowPublicBrowsing` off every
route except sign-in, sign-up and password reset answers 401.

```
GET  /portal/:slug                          # branding + which areas are enabled

GET  /portal/:slug/kb/categories
GET  /portal/:slug/kb/articles              # ?categoryId&page&pageSize
GET  /portal/:slug/kb/search?q=&limit=      # title and keyword matches rank first
GET  /portal/:slug/kb/articles/:idOrSlug    # counts the view, returns related articles
POST /portal/:slug/kb/articles/:id/feedback # { isHelpful, comment? } — one vote per signed-in reader

GET  /portal/:slug/forms · /forms/:formSlug
POST /portal/:slug/forms/:formSlug/submit   # { values, website? } -> ticket (source WEB_FORM)

POST /portal/:slug/auth/register            # { firstName, lastName?, email, password }
POST /portal/:slug/auth/login
POST /portal/:slug/auth/refresh             # ds_portal_refresh cookie -> new access token (rotates)
POST /portal/:slug/auth/logout
POST /portal/:slug/auth/forgot-password     # reset link points back at this help center
GET  /portal/:slug/auth/me

GET  /portal/:slug/tickets                  # ?open&q&page — the caller's own requests only
GET  /portal/:slug/tickets/options          # departments, categories, priorities
POST /portal/:slug/tickets                  # source PORTAL
GET  /portal/:slug/tickets/:id              # public replies only, never internal comments
POST /portal/:slug/tickets/:id/replies      # inbound message; reopens a resolved request
POST /portal/:slug/tickets/:id/attachments  # multipart/form-data, field "file"
GET  /portal/:slug/tickets/attachments/:id/download
POST /portal/:slug/tickets/:id/close

GET  /portal/:slug/community/categories · /community/topics · /community/topics/:idOrSlug
POST /portal/:slug/community/topics             # held for review when moderation is on
PATCH|DELETE /portal/:slug/community/topics/:id # author only
POST /portal/:slug/community/topics/:id/replies
POST /portal/:slug/community/topics/:id/vote    # toggle
POST /portal/:slug/community/replies/:id/vote   # toggle
POST /portal/:slug/community/replies/:id/accept # the topic's author accepts an answer
DELETE /portal/:slug/community/replies/:id
```

A portal visitor is a `User` of type `CUSTOMER` linked to a `Contact`, so the session,
refresh-token rotation and password rules are the ones the agent app already uses. The
refresh cookie is the portal's own, though — `ds_portal_refresh`, scoped to
`/api/v1/portal/:slug/auth` — and is renewed only by that help center's
`/portal/:slug/auth/refresh`, which refuses agent tokens and other organizations'
customers (401). An agent session and a portal session in one browser never collide. Sign-up reuses the contact an
agent (or an earlier form submission) already created for that email address, so the
customer sees their existing requests the first time they sign in.

Anti-spam on public submissions: a honeypot field (`website`) — a filled one is answered
as success and stored nowhere — plus the standard rate limiter (5 submissions/minute per
IP, 10 sign-ins, 5 sign-ups).

## Channels — P5 (implemented)

### Configuration (agent side)
```
GET      /channels                    # ?type&isActive
GET      /channels/catalogue          # providers per type + the credential fields each needs
GET      /channels/events             # ?channelId&status — every inbound delivery and its outcome
GET|POST /channels                    · GET|PATCH|DELETE /channels/:id
POST     /channels/:id/rotate-webhook # new URL secret; the old URL stops working at once
POST     /channels/:id/test           # a real send over the channel  { to, text? }
```
`channel.read` to read, `channel.manage` to change. Types and adapters:

| Type | Provider | Inbound | Outbound |
|---|---|---|---|
| `EMAIL` | `generic`, `mailgun`, `postmark` | webhook | through the deployment's mail provider, with threading headers |
| `CHAT` | `native` | the portal's own chat endpoints | the visitor's socket |
| `WHATSAPP` | `whatsapp_cloud` | webhook (`X-Hub-Signature-256`) | Cloud API |
| `FACEBOOK` / `INSTAGRAM` | `meta` | webhook (`X-Hub-Signature-256` + `hub.challenge`) | Graph API |
| `TELEGRAM` | `telegram` | webhook (`X-Telegram-Bot-Api-Secret-Token`) | Bot API |
| `VOICE` | `twilio` | webhook (Twilio signature) → a logged call | — |

Credentials are **write-only**: they are encrypted with `CHANNEL_ENCRYPTION_KEY` and the
API returns only the *names* of the fields that hold a value (`configuredSecrets`).
Sending a field again replaces it; sending `""` clears it; omitting it keeps it.

### Inbound webhooks (public)
```
GET  /webhooks/:channelId/:secret     # subscription handshake (Meta products)
POST /webhooks/:channelId/:secret     # one delivery
```
The URL secret is shown once, when the channel is created or its webhook is rotated; a
wrong id and a wrong secret answer identically (404), so neither can be probed. The
provider's own signature is then verified over the **raw** request bytes.

Every delivery is stored as a `ChannelEvent` before it is interpreted, keyed by the
provider's message id — so a redelivery answers `DUPLICATE` and changes nothing.
Auto-replies, bounces and list mail are stored as `IGNORED` rather than answered.

Threading, in order of confidence: `In-Reply-To`/`References` against a stored message
id, then `[#number]` in the subject, then — for conversational channels only — the
contact's own open ticket from the last 24 hours. Anything else starts a new ticket. A
customer's inbound message reopens a resolved ticket and fires `CUSTOMER_REPLIED`.

### Live chat
```
# Visitor (public, addressed by help center slug; the session token is the credential)
GET  /portal/:slug/chat/config
POST /portal/:slug/chat/start          # { name?, email?, message, pageUrl? } -> { token, session }
GET  /portal/:slug/chat/session        # X-Chat-Token
POST /portal/:slug/chat/messages       # X-Chat-Token  { body }
POST /portal/:slug/chat/end            # X-Chat-Token  { rating? }

# Agent
GET  /chat/sessions                    # ?status=QUEUED|ACTIVE|ENDED
GET  /chat/sessions/:id                # session + transcript
POST /chat/sessions/:id/accept         # assigns the ticket to the agent
POST /chat/sessions/:id/end
```
A chat is an ordinary ticket (`source: CHAT`) from the first message, so SLA, automation
and the agent workspace apply to it. Agents answer through the normal ticket endpoints;
the reply is pushed to the visitor's socket. Sockets: visitors connect to the `/chat`
namespace with their session token and receive `chat.message` / `chat.ended`; agents
receive `chat.started` on `/rt`.

### Outbound webhooks
```
GET      /webhook-endpoints            · GET /webhook-endpoints/events
GET|POST /webhook-endpoints            · PATCH|DELETE /webhook-endpoints/:id
POST     /webhook-endpoints/:id/rotate-secret | /test
GET      /webhook-deliveries           # ?endpointId&status&event
POST     /webhook-deliveries/:id/replay
```
`webhook.read` / `webhook.manage`. Events are the audit action names —
`ticket.created · ticket.updated · ticket.assigned · ticket.status_changed ·
ticket.replied · ticket.customer_replied · ticket.resolved · ticket.closed ·
contact.created · chat.started`; subscribing to none means all of them.

Each delivery is signed with the endpoint's own secret:

```
X-Digisoft-Event: ticket.created
X-Digisoft-Delivery: <delivery id>
X-Digisoft-Timestamp: <unix seconds>
X-Digisoft-Signature: t=<timestamp>,v1=<hex HMAC-SHA256 of "timestamp.body">
```
Body: `{ id, event, createdAt, data }`, where a ticket event's `data` carries the ticket
itself. Failures are retried with exponential backoff up to `WEBHOOK_MAX_ATTEMPTS`,
every attempt is recorded, and an operator can replay any delivery.

### API keys
```
GET|POST /api-keys · DELETE /api-keys/:id     # apikey.manage
```
Send the key as `X-Api-Key`. Only its hash is stored, so it is shown exactly once, at
creation. **Each key is backed by its own service user holding the role you choose**, so
a machine caller is authorised by the same permission checks, appears in the audit trail
and owns the records it creates. Revoking a key deactivates that user, closing every
path in one step.

## AI — P6 (implemented)
```
GET    /ai/settings                    # ai.use — provider, model, toggles, budget, hasApiKey
PATCH  /ai/settings                    # ai.manage — apiKey is write-only; "" clears it
GET    /ai/catalogue                   # ai.use — providers and the pinned model list with prices
POST   /ai/test                        # ai.manage — one real request to the configured provider
GET    /ai/usage                       # ai.use — this month's calls, tokens, cost, budget, by type

GET    /tickets/:id/ai                 # ai.use — latest insight of each kind for the ticket
GET    /tickets/:id/ai/articles        # ai.use — knowledge base articles that match the ticket
POST   /tickets/:id/ai                 # ai.use — { type, refresh } -> generates one insight
```
`type` is `SUMMARY`, `SENTIMENT`, `INTENT` or `SUGGESTED_REPLY`. Without `refresh`, an
insight generated since the last message on the ticket is returned as it stands rather
than paid for again.

Two providers implement the same interface: `ANTHROPIC` (the official SDK, one of four
pinned models) and `HEURISTIC`, a rule-based analyser that runs in-process and needs no
credentials — it is the default, so the assistant works out of the box.

Responses never contain the stored API key; `hasApiKey` says whether one is held.
A request is refused with `VALIDATION_ERROR` when the assistant is off, the individual
feature is off, or the organization's monthly token budget is spent. The suggested reply
is a draft returned to the agent — nothing is ever sent to a customer, and an intent's
category and priority are applied only when the agent presses the button. Internal
comments are never included in what is sent to a provider.

## Analytics — P7 (implemented)
```
GET    /dashboard                      # report.read — the landing-screen summary
GET    /reports/tickets                # report.read — volume, breakdowns, trend
GET    /reports/agents                 # report.read — per-agent activity and CSAT
GET    /reports/sla                    # report.read — compliance, at-risk, by policy
GET    /reports/csat                   # report.read — ratings, distribution, comments

GET    /reports/exports                # report.read — this organization's exports
POST   /reports/export                 # report.read — { kind, filters } -> QUEUED
GET    /reports/exports/:id            # report.read — status, row/byte counts
GET    /reports/exports/:id/download   # report.read — 302 to a signed URL, or streamed

GET    /report-definitions             # report.read — saved filter sets
POST   /report-definitions             # report.manage
GET    /report-definitions/:id         # report.read
PATCH  /report-definitions/:id         # report.manage
DELETE /report-definitions/:id         # report.manage

GET    /csat/settings                  # report.read
PATCH  /csat/settings                  # report.manage
GET    /tickets/:id/csat               # ticket.read — this ticket's survey, if any

GET    /csat/:token                    # @Public — the survey behind an emailed link
POST   /csat/:token                    # @Public — { rating, comment? }; answers once
```
Every report takes `range` (`today`, `7d`, `30d`, `90d`, or `custom` with `from`/`to`),
plus `departmentId`, `agentId`, `priorityId` and `channelId` filters. Tickets and agents
read from daily rollup tables the worker recomputes on a schedule; a request itself
recomputes today's and yesterday's rows first if the sweep has not run recently, so a
report is never stale by more than that recompute.

An export is a queued job, not a synchronous download: the row moves `QUEUED` → `READY`
(or `FAILED`) as the worker renders the CSV to the same storage attachments use, and the
download endpoint re-authorises exactly like an attachment download.

CSAT: when a ticket is resolved, and surveys are on, exactly one `CsatResponse` is
created and its raw token is emailed — never returned by any authenticated endpoint. The
public endpoints know nothing but that token; answering rotates it to `ANSWERED` and a
second attempt is refused.

## Notifications — P1 (implemented)
```
GET    /notifications?page&pageSize&unreadOnly
GET    /notifications/unread-count
POST   /notifications/:id/read
POST   /notifications/read-all
```

## Health — P1 (implemented)
```
GET    /health                        # @Public; reports database and redis status
```

## Search — P2
```
GET    /search?q=&types=tickets,contacts,accounts,articles
```

## Socket.IO events (§43)

Namespace `/rt`, authenticated on handshake with the access token. A socket joins
`org:{id}` and `org:{id}:user:{userId}` only, so a broadcast cannot cross a tenant
boundary. Ticket and department rooms arrive with Phase 2.

Implemented today: `ticket.created`, `ticket.updated`, `ticket.assigned`,
`ticket.status_changed`, `message.created`, `sla.warning`, `sla.breached`,
`notification.created`, `agent.online`, `agent.offline`. Worker-originated ticket
events carry an `audience` and are routed to the same rooms as API-originated ones.

Ticket events are addressed to three rooms — the organization's full-queue room (joined
only by sockets whose user holds `ticket.read.all`), the ticket's department room, and
the assignee — so a socket is never sent an event for a ticket its user could not open
through the API. Background workers publish envelopes on the Redis channel `rt:emit`,
which the API instances fan out to their own sockets.

```
server -> client: ticket.created · ticket.updated · ticket.assigned ·
                  ticket.status_changed · message.created · comment.created ·
                  notification.created · agent.online · agent.offline ·
                  chat.message · chat.typing · sla.warning · sla.breached
client -> server: ticket.subscribe · ticket.unsubscribe · chat.message ·
                  chat.typing · presence.ping
```

## Error codes (initial catalogue)

`VALIDATION_ERROR` · `UNAUTHENTICATED` · `TOKEN_EXPIRED` · `INVALID_CREDENTIALS` ·
`FORBIDDEN` · `PERMISSION_DENIED` · `NOT_FOUND` · `<ENTITY>_NOT_FOUND` ·
`CONFLICT` · `EMAIL_ALREADY_EXISTS` · `RATE_LIMITED` · `FILE_TOO_LARGE` ·
`UNSUPPORTED_MEDIA_TYPE` · `WEBHOOK_SIGNATURE_INVALID` · `INTERNAL_ERROR`
