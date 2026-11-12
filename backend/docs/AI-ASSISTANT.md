# WorkEasy360 AI assistant — Helpdesk

Every WorkEasy360 product can have a built-in assistant. It answers from the product's
live data, opens the right page, and prepares changes for the user to confirm. The
engine, the chat window and the safety rules are the same in every product. Each product
supplies its own **tools**, **actions**, **pages** and **prompt**.

This is the Helpdesk copy: the shared sections are the blueprint's, and the product
sections are filled in. The chat window's styling is in
[frontend/docs/DESIGN-SYSTEM.md](../../frontend/docs/DESIGN-SYSTEM.md).

Words used below:

- **Workspace:** the tenant the user works inside. In Helpdesk that is an **organization**.
- **Member:** the signed-in user, with a role and permissions in that organization.

## What the user sees

- A round chat button (`c-fab`) floats in the bottom-right corner of every agent page.
- **Desktop and tablet:** it opens a chat window (`c-chatbox`) just above the button. The
  window doesn't block the page, so it stays visible and usable.
- **Phones:** the chat takes the whole screen, with a close button in its header.
- **Keyboard:** Escape closes the chat, and focus returns to the button.
- An answer can include a link button ("Open …") and a **confirmation card**: a title, the
  checked facts as label/value rows, one sentence saying what will happen, and a button.
  Nothing changes until the member presses that button.
- The chat history stays in the browser tab (session storage, `digisoft-assistant-thread`).
  The server stores no conversations.

**Per product:** the button reads "Ask the assistant". It renders nothing at all for a
role without `ai.use`, so a light agent never sees it. There is no "the assistant is not
set up" state: the chat always works.

## How it works

1. The member asks a question. `POST /api/v1/assistant` runs behind the same JWT guard and
   permission guard as every other route: an authenticated member of this organization
   with `ai.use`, or nothing. It then takes one question from the organization's daily
   allowance — the only thing that can refuse a question.
2. The model receives the prompt plus a context block: organization, member, roles,
   timezone, today's date, and **only** the tools, actions and pages that role may use.
3. The model replies with one JSON object (see "Reply format"). It either asks for a
   **read-only tool** or gives an **answer**. It may use up to 4 tools per question.
4. Each tool runs as its own short read, scoped to the organization by the tenant
   extension. The member's permissions are checked again on every call, so a role change
   takes effect mid-question.
5. An answer can include a **link** and a **proposed action**. The server resolves both
   against the organization as it is now:
   - a link the role can't open is dropped
   - an action is checked against the record and the role, using the same Zod schema the
     product's own form and endpoint use
   - the result is a confirmation card (an `AssistantProposal`), or a short note saying why
     it can't be done
6. When the member presses the card's button, the frontend calls the product's **existing
   endpoint**, the same one its own page uses, which validates, audits and reports the real
   result. A change is reported as done only when the server says so.

## Reply format

Every model reply is exactly one JSON object.

```json
{"type": "tool", "tool": "<tool name>", "args": { } }
```

```json
{"type": "answer", "text": "<reply>", "navigate": null | "<page key>" | "<record>:<id>", "action": null | {"kind": "<action kind>", "...": "args"}}
```

Tool results go back to the model inside `<tool_result name="…">` tags, truncated at
12,000 characters — and the model is told when a result was truncated, so it narrows the
search rather than assuming the rest.

## The code

Helpdesk is a pnpm workspace, not the Commerce layout, so the blueprint's files map like
this:

| Part | Where | Reuse |
|---|---|---|
| `JsonCompletionProvider`, the Anthropic caller and the stub | `packages/ai/src/assistant/providers.ts` | Copy unchanged |
| The loop: `runAssistantTurn`, `parseAssistantReply`, `plainText`, `assistantSystem`, the limits | `packages/ai/src/assistant/loop.ts` | Copy unchanged |
| Tool, action and page specs, `assistantCapabilities`, `assistantSuggestions` | `packages/ai/src/assistant/specs.ts` | Rewrite for the product |
| `ASSISTANT_PROMPT` | `packages/ai/src/assistant/prompt.ts` | Rewrite for the product |
| The tool runners | `api/src/ai/assistant/assistant.tools.ts` | Rewrite for the product |
| `verifyAction` and the proposals | `api/src/ai/assistant/assistant.actions.ts` | Rewrite for the product |
| The route: allowance, tool runner, link and action resolution, logging | `api/src/ai/assistant/assistant.service.ts`, `assistant.controller.ts` | Keep the three steps; rewrite the rest |
| The chat window and confirmation card | `frontend/components/assistant/assistant-panel.tsx` | Copy; change the API path and the welcome suggestions |
| Styles | `c-fab`, `c-chatbox` in `frontend/app/components.css` | Already shared |
| The request/response contract | `packages/shared/src/assistant.ts` (mirrored to `frontend/shared/`) | Copy unchanged |
| Usage counter | `ai_usage_days.assistant_messages` (migration `20261110075924_assistant_usage`) | Same column, same upsert |

**Where this deviates from the blueprint, and why.** Commerce selects its provider from
`AI_PROVIDER` in the environment. Helpdesk already stores the provider **per organization**
in `ai_settings`, next to the per-ticket insight settings, and encrypts the API key with
the same key channel credentials use. So:

- `AI_PROVIDER=gemini|openai` → `AI_PROVIDER=GEMINI` or `ANTHROPIC`, plus `AI_API_KEY`.
  OpenAI is not implemented here; adding it is one more `JsonCompletionProvider`.
- `AI_PROVIDER=stub` → `AI_PROVIDER=HEURISTIC`, the default. `createAssistantProvider`
  returns the deterministic stub, so the chat works out of the box and reports that it
  has no model behind it.
- `AI_PROVIDER=disabled` → **there is no equivalent, deliberately.** The assistant is
  always on. An organization that has configured nothing still gets a working chat from
  the built-in deterministic provider, so there is no state in which an agent opens the
  chat and is told the feature is unavailable.

There is no switch to find: the only thing that decides whether an agent *sees* the
assistant is the `ai.use` permission on their role. What the assistant *runs on* is set
in the environment — `AI_PROVIDER`, `AI_MODEL` and `AI_API_KEY`, documented in
[ENVIRONMENT.md](./ENVIRONMENT.md).

## Per product

### 1. Tools (read-only)

| Tool | Permission | Returns |
|---|---|---|
| `helpdesk_overview` | — | The organization, its timezone, today, and the ticket counts this member can see. Always called first |
| `search_tickets` | `ticket.read` | Number, subject, status, priority, assignee, requester, SLA state, updated-at |
| `get_ticket` | `ticket.read` | One ticket in full, plus its last five messages |
| `list_ticket_options` | `ticket.read` | The statuses, priorities, categories and tags this organization configured, with ids |
| `list_agents` | `user.read` | Agents and departments, with each agent's open-ticket count |
| `search_contacts` | `contact.read` | Contacts with their account and open-ticket count |
| `search_articles` | `kb.read` | Knowledge base matches with an extract and whether they are published |
| `ticket_metrics` | `report.read` | Volume, SLA compliance and CSAT over a range |

Rules these follow:

- Every runner **re-checks its permission**, clamps its limit (10–20 rows at most) and
  ignores unknown or malformed arguments rather than failing.
- Ticket reads go through `ticketVisibilityFilter`, the same filter the Tickets page uses,
  so an agent without `ticket.read.all` sees their own and their departments' queues here
  too — never more.
- Only what the assistant needs comes back. `search_contacts` returns the email address,
  because that is how an agent identifies a requester, and deliberately not the phone
  number or the postal address.
- Dates are ISO strings; durations are minutes.
- A status has no category column in this schema — it carries `isResolved` / `isClosed` /
  `pausesSla` flags — so the tools derive the four categories exactly as the ticket list
  does, and the assistant's counts match what the member sees on screen.

### 2. Actions (confirmed by the member)

| Action | Permission | Endpoint it proposes |
|---|---|---|
| `assign_ticket` | `ticket.assign` | `POST /tickets/:id/assign` |
| `set_ticket_status` | `ticket.update` | `POST /tickets/:id/status` |
| `set_ticket_priority` | `ticket.update` | `POST /tickets/:id/priority` |
| `resolve_ticket` | `ticket.update` | `POST /tickets/:id/resolve` |
| `reopen_ticket` | `ticket.update` | `POST /tickets/:id/reopen` |
| `add_internal_note` | `ticket.comment` | `POST /tickets/:id/comments` |

Each one **parses** (well-formed arguments only, clamped), **verifies** (loads the record,
checks its state, runs the endpoint's own Zod schema) and **proposes** a card. A ticket
already resolved gets no resolve card; a status that resolves the ticket without a
resolution note gets a request for one instead, because that is what the endpoint would
demand.

**Deliberately absent, and the prompt says so:**

- **Replying to a customer.** A public reply is a message leaving the business in the
  organization's name. The assistant can add an internal note; the reply itself stays with
  the agent, in the composer.
- **Merging and deleting.** Neither can be undone. The assistant explains the steps and
  links to the ticket.

### 3. Pages

The page list in `specs.ts` mirrors `frontend/lib/modules.tsx` — the same modules, the same
paths — plus two deep links agents ask for by name (unassigned, overdue). Record links are
`ticket:<id>`, `contact:<id>`, `account:<id>` and `article:<id>`; `resolveLink` confirms the
record exists, that this member may open it, and names it before the link is shown.

### 4. The prompt

`ASSISTANT_PROMPT` in `packages/ai/src/assistant/prompt.ts`, with the blueprint's ten
sections in the blueprint's order. Sections 2, 3, 5, 7, 8 and 9 carry over from the other
products with only the nouns changed. The product's own are:

1. **Who you are** — a support platform; the members are agents, leads and admins.
4. **How support works here** — the domain rules the assistant may never bend: statuses
   belong to four categories and are named per organization; priority is not SLA; resolving
   needs a note and is not closing; an internal comment is invisible to the customer and a
   reply is not; merges and deletes are irreversible; a requester is a contact, an agent is
   a user.
6. **How the app works** — the real sidebar, saved views, composer tabs and settings paths,
   so how-to answers match the screen.
10. **Examples** — ten, including two refusals (merge, reply) and one credentials refusal.

## Safety

- **Workspace isolation** comes from the tenant Prisma extension and the JWT guard, not
  from the prompt. Every assistant query runs through `TENANT_PRISMA` inside the request's
  `TenantContext`, so a row from another organization cannot be read even if the model asks
  for it by id. A member of another organization gets 404 from the route guard, exactly as
  on every other route.
- **The model cannot write.** It has no write tools, and its `action` is only a suggestion
  that `verifyAction` then checks. Forged chat history doesn't help an attacker either:
  history is client-supplied and never treated as authority, and every tool and endpoint
  re-checks the signed-in member.
- **Tool results are data.** They are wrapped in `<tool_result>` tags and the prompt's
  "Untrusted content" section tells the model never to follow instructions found inside
  them.
- **Replies are checked.** Every reply is validated against the JSON format. A malformed
  reply gets one correction, and a second one ends the question with an error. Links outside
  the page list and unknown action kinds are dropped.
- **What's logged:** the tools used, success or failure, and token counts. Questions,
  answers and tool data are not. Confirmed actions appear in the audit log through their
  endpoints, attributed to the member who pressed the button — not to the assistant.

## Settings and limits

Under **Settings → Assistant** (`ai.manage` to change, `ai.use` to see):

| Setting | Column | Meaning |
|---|---|---|
| Provider and model | `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` (environment) | `ANTHROPIC` or `GEMINI` with a key, or `HEURISTIC` for the local stub. Deployment-wide, not per organization |
| Questions per day | `ai_settings.assistantDailyLimit` | Shared by the whole organization, reset at midnight UTC. Default 200; 0 means no limit |

**There is no on/off switch, by design.** The assistant is on for every organization from
the moment it exists. `assistantDailyLimit` is a spend guard, not a switch: 0 means *no
limit* rather than *off*, so it cannot be used to disable the feature by the back door.
To keep the assistant away from a particular role, remove `ai.use` from it — then the
button never renders and the route returns 403.

The allowance is taken in one upsert on `ai_usage_days` **before** the model is called, so a
failed answer still costs its question and two questions arriving together cannot both take
the last slot.

Limits on one question (`ASSISTANT_LIMITS`):

- 4 tools at most, and 50 seconds in total
- replies capped at 1,500 tokens
- the last 12 messages of history are sent
- a question can be up to 2,000 characters
- a per-member rate limit of 20 questions a minute, on top of the organization's allowance

## Tests

`packages/ai/src/assistant/assistant.spec.ts` covers the engine, per the blueprint's
checklist: the stub provider end to end; a role without the permission gets no tool and no
action; a malformed reply is corrected once and then fails; the tool budget, the deadline and
the truncation notice; and that the prompt still states the rules it must.

Cross-organization isolation is covered where it is enforced — the tenant extension's own
suite — rather than re-asserted here.

Not yet written, and worth adding: an API-level suite that drives `POST /api/v1/assistant`
against a seeded organization and asserts each action's `verifyAction` refuses exactly what
its endpoint refuses.
