# Digisoft360 Help Desk — Data Model

> Status: **Phases 1–5 are implemented and migrated.** Later-phase tables are planned
> shapes, not yet created.

Schema, migrations and seed live in `backend/packages/db`. The initial migration is
`backend/packages/db/prisma/migrations/*_init`.

PostgreSQL 16 + Prisma. JSONB is used only where fields are genuinely user-configurable (custom fields, automation rule bodies, form schemas, audit diffs).

## 1. Entity map

```
Organization (tenant root)
├── User ──< UserRole >── Role ──< RolePermission >── Permission
│     └──< UserDepartment >── Department ──< TeamMember >── Team
├── Contact ──> Account
├── Account
├── Ticket ──> Contact, Account, Department, User(assignee),
│   │          TicketStatus, TicketPriority, Category, SlaPolicy
│   ├──< TicketMessage ──< Attachment
│   ├──< TicketTag >── Tag
│   ├──< TicketHistory (audit)
│   ├──< TicketFollower
│   ├──< TicketLink (related/merged)
│   ├──< SlaTimer
│   ├──< Activity (task/call/event)
│   ├──  CsatResponse
│   └──< AiInsight
├── SlaPolicy ──< SlaTarget
├── BusinessHours ──< Holiday
├── AutomationRule (trigger + conditions JSONB + actions JSONB)
├── AssignmentRule
├── Blueprint ──< BlueprintTransition
├── HelpCenter (one per organization: portal address, branding, switches)
├── KbCategory ──< KbArticle ──< KbArticleFeedback
├── CommunityCategory ──< CommunityTopic ──< CommunityReply ──< CommunityVote
├── Channel (email/chat/whatsapp/... config, secrets encrypted)
│   ├──< ChannelIdentity ──> Contact
│   ├──< ChannelEvent (raw inbound payloads, dedupe + audit)
│   └──< ChatSession ──> Ticket
├── ApiKey ──> Role, User (service identity)
├── WebForm
├── Notification
├── WebhookEndpoint ──< WebhookDelivery
└── AuditLog
```

## 2. Conventions

- PK: `String @id @default(cuid())`.
- Tenant column: `organizationId String` + `@@index([organizationId, ...])` on every query path.
- Timestamps: `createdAt @default(now())`, `updatedAt @updatedAt`.
- Soft delete: `deletedAt DateTime?` on `Organization`, `User`, `Department`, `Team`,
  `Contact`, `Account` (and later `Ticket`, `KbArticle`). The Prisma extension adds
  `deletedAt: null` to reads unless the caller filters on it explicitly, so a deleted
  row can still be inspected or restored deliberately.
- Enums are used only for values the *product* controls (`ChannelType`, `MessageType`, `ActivityType`). Ticket **status and priority are tables**, not enums (§15/§16) — the seeded rows are `NEW/OPEN/IN_PROGRESS/ON_HOLD/PENDING/RESOLVED/CLOSED` and `LOW/MEDIUM/HIGH/URGENT`, each with a `systemKey` plus `isDefault`, `isResolved`, `isClosed` behaviour flags so no code branches on the literal name.
- Money/duration: minutes as `Int`; all timestamps `timestamptz`.
- `customFields Json?` on `Ticket`, `Contact`, `Account`.

## 3. Phase 1 schema (`backend/packages/db/prisma/schema.prisma`)

```prisma
model Organization {
  id               String   @id @default(cuid())
  name             String
  slug             String   @unique
  logoUrl          String?
  domain           String?
  timezone         String   @default("UTC")
  locale           String   @default("en")
  currency         String   @default("USD")
  settings         Json     @default("{}")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  deletedAt        DateTime?
  // relations: users, roles, departments, teams, contacts, accounts, businessHours, ...
}

model BusinessHours {
  id             String  @id @default(cuid())
  organizationId String
  name           String
  timezone       String
  isDefault      Boolean @default(false)
  // [{ day: 1, start: "09:00", end: "18:00" }, ...]
  weeklySchedule Json
  holidays       Holiday[]
  @@index([organizationId])
}

model Holiday {
  id              String   @id @default(cuid())
  organizationId  String
  businessHoursId String
  name            String
  date            DateTime @db.Date
  @@index([organizationId, date])
}

model User {
  id               String    @id @default(cuid())
  organizationId   String
  email            String
  passwordHash     String?
  firstName        String
  lastName         String
  avatarUrl        String?
  phone            String?
  type             UserType  @default(AGENT)   // AGENT | CUSTOMER
  contactId        String?   @unique           // set when type = CUSTOMER
  isActive         Boolean   @default(true)
  emailVerifiedAt  DateTime?
  lastLoginAt      DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  deletedAt        DateTime?
  @@unique([organizationId, email])
  @@index([organizationId, isActive])
}

// Sign in with Workeasy360 (migration 20261012120000_workeasy360_sso). A tenant model.
// A user belongs to one organization, so one Workeasy360 person in two organizations is
// two User rows, each with its own identity. Organization.workeasy360OrganizationId
// (uuid, unique, nullable) binds an organization to its Workeasy360 organization.
model ExternalIdentity {
  id             String   @id @default(cuid())
  organizationId String
  userId         String
  issuer         String   // exact issuer string
  subject        String   // the token's sub; never the email
  email          String?  // last reported address, profile data only
  lastLoginAt    DateTime @default(now())
  createdAt      DateTime @default(now())
  @@unique([issuer, subject, organizationId])
  @@unique([issuer, userId])
}

model Role {
  id             String  @id @default(cuid())
  organizationId String
  name           String
  systemKey      String? // SUPER_ADMIN | ADMIN | AGENT | LIGHT_AGENT | CUSTOMER
  description    String?
  isSystem       Boolean @default(false)
  @@unique([organizationId, name])
}

model Permission {          // global catalogue, not tenant-scoped
  id          String @id @default(cuid())
  key         String @unique   // "ticket.read", "ticket.assign", ...
  resource    String
  action      String
  description String
}

model RolePermission { roleId String; permissionId String; @@id([roleId, permissionId]) }
model UserRole       { userId String; roleId String;       @@id([userId, roleId]) }

model Department {
  id             String  @id @default(cuid())
  organizationId String
  name           String
  description    String?
  email          String?          // department support address
  isDefault      Boolean @default(false)
  parentId       String?          // sub-departments
  @@unique([organizationId, name])
}

model UserDepartment { userId String; departmentId String; @@id([userId, departmentId]) }

model Team {
  id             String @id @default(cuid())
  organizationId String
  departmentId   String?
  name           String
  @@unique([organizationId, name])
}
model TeamMember { teamId String; userId String; @@id([teamId, userId]) }

model Account {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  website        String?
  industry       String?
  phone          String?
  email          String?
  addressLine1   String?
  addressLine2   String?
  city           String?
  state          String?
  postalCode     String?
  country        String?
  description    String?
  customFields   Json?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?
  @@index([organizationId, name])
}

model Contact {
  id             String        @id @default(cuid())
  organizationId String
  accountId      String?
  firstName      String
  lastName       String?
  email          String?
  phone          String?
  mobile         String?
  jobTitle       String?
  avatarUrl      String?
  status         ContactStatus @default(ACTIVE)
  isVip          Boolean       @default(false)
  customFields   Json?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  deletedAt      DateTime?
  @@unique([organizationId, email])
  @@index([organizationId, accountId])
}

model RefreshToken {
  id             String   @id @default(cuid())
  userId         String
  organizationId String
  tokenHash      String   @unique
  familyId       String
  userAgent      String?
  ip             String?
  expiresAt      DateTime
  revokedAt      DateTime?
  createdAt      DateTime @default(now())
  @@index([userId, familyId])
}

model VerificationToken {
  id        String   @id @default(cuid())
  userId    String
  type      TokenType    // EMAIL_VERIFICATION | PASSWORD_RESET | INVITE
  tokenHash String   @unique
  expiresAt DateTime
  usedAt    DateTime?
  @@index([userId, type])
}

model AuditLog {
  id             String   @id @default(cuid())
  organizationId String
  actorId        String?
  actorType      String   @default("USER")   // USER | SYSTEM | AUTOMATION
  action         String                      // "ticket.status_changed"
  entity         String
  entityId       String
  oldValue       Json?
  newValue       Json?
  ip             String?
  createdAt      DateTime @default(now())
  @@index([organizationId, entity, entityId, createdAt])
  @@index([organizationId, createdAt])
}
```

## 4. Later-phase tables (shape fixed now, migrated in their phase)

- **Phase 2 (built)** — `Ticket`, `TicketStatus`, `TicketPriority`, `TicketCategory`,
  `Tag`, `TicketTag`, `TicketMessage`, `Attachment`, `TicketFollower`, `TicketLink`.
  Two decisions differ from the original sketch:
  - `TicketMessage.type` is an enum (`PUBLIC_REPLY` / `INTERNAL_COMMENT` /
    `SYSTEM_NOTE`) rather than an `isInternal` boolean, so system notes are a first
    class kind instead of a third state squeezed into a flag.
  - There is no separate `TicketHistory` table: `GET /tickets/:id/history` reads
    `AuditLog` filtered to the ticket. One append-only trail is easier to keep correct
    than two, and it already carries actor, action, old and new values.
- **Phase 3 (built)** — `Activity`, `AssignmentRule`, `AutomationRule`, `AutomationRun`,
  `SlaPolicy`, `SlaTarget`, `Blueprint`, `BlueprintTransition`. Three decisions differ
  from the sketch:
  - **No `SlaTimer` table.** The clock lives on `Ticket` (`slaPolicyId`,
    `firstResponseDueAt`, `resolutionDueAt`, `*WarnedAt`, `*BreachedAt`, `slaPausedAt`,
    `firstResponseRemainingMin`, `resolutionRemainingMin`), indexed on the two due
    columns. Pausing stores the *remaining business minutes*; resuming rebuilds the due
    dates from now on the policy's calendar, so a weekend spent on hold is not handed
    back to the customer as extra time.
  - **No `EscalationRule` table.** An escalation is an `AutomationRule` on the
    `SLA_WARNING` / `SLA_BREACHED` trigger — one engine, one run log.
  - `TicketStatus.pausesSla` marks statuses that stop the clock (On Hold and Pending by
    default). `AutomationRun` records every evaluation, matched or not, with the action
    outcomes, so "why didn't my rule fire" is answerable from the data.
- **Phase 4 (built)** — `HelpCenter`, `KbCategory`, `KbArticle`, `KbArticleFeedback`,
  `WebForm`, `CommunityCategory`, `CommunityTopic`, `CommunityReply`, `CommunityVote`,
  plus the enums `ArticleStatus`, `ContentVisibility`, `TopicType`, `TopicStatus` and
  `ModerationStatus`. Four decisions differ from the sketch:
  - **`HelpCenter` is its own table**, one row per organization, holding the portal
    address (`slug`, unique across the platform — it is how an anonymous request finds
    its tenant), branding and the feature switches. Organization settings JSON would
    have made the slug unindexable and the switches untyped.
  - **No tsvector column yet.** Portal search runs two indexed `ILIKE` queries — title
    and keywords first, then summary and body — and merges them, so title matches rank
    above body matches without a search engine in front of PostgreSQL. The generated
    `tsvector` + GIN index is the upgrade path when volume needs it, behind the same
    endpoint.
  - **`CommunityReply`, not `CommunityPost`**, and authorship is a `User` on topics,
    replies and votes alike: a portal visitor *is* a `User` of type `CUSTOMER` linked to
    a `Contact`, so one relation covers customers and agents and `@@unique([topicId,
    userId])` / `@@unique([replyId, userId])` make one-vote-per-person a database rule.
  - **Counters are maintained transactionally.** `CommunityTopic.replyCount` /
    `voteCount`, `CommunityReply.voteCount` and `KbArticle.helpfulCount` /
    `notHelpfulCount` move in the same transaction as the row that caused them, so a
    listing never has to aggregate. Approving or rejecting a held reply adjusts the
    topic's count in the same step.
  - Soft deletes release the slug (`…-deleted-<time>`), so an address can be used again
    after the row it belonged to is gone.
- **Phase 5 (built)** — `Channel`, `ChannelIdentity`, `ChannelEvent`, `ChatSession`,
  `WebhookEndpoint`, `WebhookDelivery`, `ApiKey`, plus `Ticket.channelId`,
  `Activity.externalCallId` / `recordingUrl` and the enums `ChannelType`,
  `ChannelEventStatus`, `ChatSessionStatus`, `DeliveryStatus`. Five decisions differ
  from the sketch:
  - **No `EmailInbox`, `EmailMessageRef`, `ChatConversation` or `CallLog`.** A
    conversation is a `Ticket` whatever brought it in, its messages are `TicketMessage`
    rows carrying the provider's id in `externalMessageId` (already unique per
    organization, which is what threading matches on), and a call is an `Activity` of
    type `CALL` with its recording. Four tables of near-duplicates would have meant four
    places to keep the conversation rules correct.
  - **`ChannelEvent` stores the raw delivery before it is interpreted.** Its unique
    `(channelId, externalId)` is the idempotency key — a provider that redelivers
    changes nothing — and it doubles as the audit trail and the answer to "why did that
    email not become a ticket".
  - **`ChatSession` holds only what a live visit adds**: the hashed visitor token, the
    queue state, the page they were on and the rating. The conversation itself is the
    ticket, so chat inherits SLA, automation and the workspace unchanged.
  - **`ChannelIdentity` maps an external identity to a contact** (address, E.164 number,
    page-scoped id, chat id), unique per organization and type. It is how a reply finds
    the person, and how the same human writing from two channels stays one contact.
  - **`ApiKey.userId` points at a service `User`.** A machine caller needs a real
    identity or every ownership column and audit row would have to special-case it.
- **Phase 5 (planned, not built)** — a provider-agnostic outbound *email send* per
  channel (today outbound email uses the deployment's configured provider) and IMAP
  polling for mailboxes without a webhook relay.
- **Phase 6 (built)** — `AiSettings`, `AiInsight` and the enums `AiProviderKind`,
  `AiInsightType`, `AiInsightStatus`. Two decisions differ from the sketch:
  - **One `AiInsight` table instead of `AiRequestLog` beside it.** Every call is stored
    as a row whatever its outcome, carrying the result (`content` JSON), the provider and
    model, input/output tokens, `costMicros`, `latencyMs` and, on a failure, `error` with
    `status = FAILED`. The log *is* the result, so usage, cost, budget enforcement and
    "what did it last say about this ticket" all read one table, and a failure is
    debuggable without a second write path.
  - **`AiSettings` replaces `AiProviderConfig`, one row per organization** (`@unique`
    organizationId), holding the provider, model, per-feature switches, auto-analysis,
    the monthly token budget and free-text guidance. The API key lives in `secrets`,
    encrypted with the same AES-256-GCM helper as channel credentials, and is never
    selected into a response. The row is created on first read, and a create that loses
    the race re-reads instead of failing.
  - `pgvector` and `KbArticleEmbedding` are still later work: retrieval today is keyword
    scoring over published articles (title ×3, summary ×2, body ×1).
- **Phase 7 (built)** — `TicketDailyMetric`, `AgentDailyMetric`, `CsatSettings`,
  `CsatResponse`, `ReportDefinition`, `ReportExport` and the enums `CsatStatus`,
  `ReportKind`, `ExportStatus`. Three decisions differ from the sketch:
  - **Rollups are per-department rows, not a total plus breakdowns.** `TicketDailyMetric`
    has one row per `(organizationId, day, departmentId)` — `departmentId = null` is the
    department-less queue, not an organization total — so an organization figure is the
    sum of that day's rows and a department figure is one row's lookup. `AgentDailyMetric`
    is the same shape, keyed by agent.
  - **A report is never older than the last two days.** Rather than trusting the worker's
    schedule, a report request itself recomputes today's and yesterday's rollup rows
    first if they have not been touched in the last two minutes, so a dashboard opened
    moments after a ticket closes shows that ticket.
  - **CSAT stores only a token hash**, the same pattern as `VerificationToken`: the raw
    token exists only in the emailed link, `CsatResponse.tokenHash` is unique, and there
    is no way for a database copy — or an authenticated API response — to answer a
    survey on the customer's behalf.

## 4a. Ticket numbering

`Ticket.ticketNumber` is sequential **per organization**, not global. The counter lives
in `Organization.ticketSequence` and is bumped with an `increment` inside the same
transaction that inserts the ticket, so the row lock serialises concurrent creates and
no two tickets can share a number. `@@unique([organizationId, ticketNumber])` is the
backstop, and a concurrency test asserts five simultaneous creates produce 1–5.

## 5. Isolation in the data layer

`backend/packages/db/src/tenant.extension.ts` wraps every Prisma operation:

- reads, updates and deletes against a tenant-owned model get `organizationId` merged
  into `where` — a caller-supplied value is overwritten, never trusted;
- creates get `organizationId` stamped onto the row;
- with no tenant context the query throws rather than running unscoped (fail closed);
- `TenantContext.runUnscoped()` is the only escape hatch, used by login lookup and
  organization provisioning, and is grep-auditable.

The rewriting logic is a pure function (`scopeArgs`) so the rules are unit tested
directly, and the guarantee is tested again end to end in
`backend/api/test/tenant-isolation.e2e-spec.ts`.

Join tables (`UserRole`, `UserDepartment`, `TeamMember`, `RolePermission`) carry no
`organizationId`; they are only reachable through a parent row whose ownership the
owning service verifies first. `Permission` is a global catalogue by design.

## 6. Indexing plan (§49)

Every one of these is a composite index leading with `organizationId`:
`Ticket(statusId)`, `Ticket(priorityId)`, `Ticket(assignedAgentId, statusId)`, `Ticket(departmentId, statusId)`, `Ticket(contactId)`, `Ticket(accountId)`, `Ticket(createdAt)`, `Ticket(dueAt)` (partial: `WHERE "closedAt" IS NULL`), `TicketMessage(ticketId, createdAt)`, `Activity(ticketId)`, `AuditLog(entity, entityId, createdAt)`, `Contact(email)`, `Account(name)`.
Phase 5 adds: `Channel(type, isActive)`, unique `Channel(organizationId, type,
identifier)`, unique `ChannelEvent(channelId, externalId)`, `ChannelEvent(status,
createdAt)`, unique `ChannelIdentity(organizationId, type, externalId)`,
`ChatSession(status, lastSeenAt)`, `WebhookDelivery(endpointId, createdAt)`,
`WebhookDelivery(status)`, unique `ApiKey.keyHash`, and unique
`Activity(organizationId, externalCallId)` so a telephony provider can post the same
call several times without duplicating it.

Phase 6 adds: unique `AiSettings(organizationId)`, `AiInsight(organizationId,
ticketId, type, createdAt)` for "latest of each kind on this ticket", and
`AiInsight(organizationId, createdAt)` for the monthly usage and budget queries.

Phase 7 adds: unique `CsatSettings(organizationId)`, unique `CsatResponse.tokenHash`,
unique `CsatResponse(organizationId, ticketId)` (one survey per ticket), `CsatResponse
(organizationId, status, respondedAt)` and `(organizationId, agentId, respondedAt)` for
the CSAT report; unique `ReportDefinition(organizationId, name)`; `ReportExport
(organizationId, createdAt)`; unique `TicketDailyMetric(organizationId, day,
departmentId)` and unique `AgentDailyMetric(organizationId, day, agentId)`, both indexed
on `(organizationId, day)` for the range scan a report runs.

Phase 4 adds: `KbArticle(status, visibility)`, `KbArticle(categoryId, position)`,
`KbCategory(parentId, position)`, `WebForm(isActive)`, `CommunityTopic(categoryId,
lastActivityAt)`, `CommunityTopic(moderation)`, `CommunityReply(topicId, createdAt)`,
`CommunityVote(userId)`, plus the platform-wide unique `HelpCenter(slug)`.

Full-text: generated `tsvector` columns with GIN indexes on `Ticket(subject, description)` and `KbArticle(title, body)` are the planned upgrade — today both searches use indexed `ILIKE` — and the search layer sits behind a `SearchService` interface so OpenSearch can replace the implementation (§44).
