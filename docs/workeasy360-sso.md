# Sign in with Workeasy360

**Written for: whoever deploys or operates Easy Help Desk.**

Easy Help Desk is a Workeasy360 product. Agents sign in with their Workeasy360 account; the Help Desk never sees their password. With `WORKEASY360_SSO_ONLY` on (the default in production) it is the only way agents get in: password sign-in, self-registration, password reset and invitation emails are switched off, because people, plans and organizations are managed in Workeasy360. The customer portal (the `/help/<slug>` help center and its customer accounts) is separate and unchanged.

The protocol is OpenID Connect authorization code with PKCE and `private_key_jwt` client authentication, as laid out in Workeasy360's product integration guide. Nothing here needs a change to nginx: the sign-in routes live under `/api/auth/`, which the `/api/` rule already sends to the API.

## How a sign-in works

1. The person clicks **Continue with Workeasy360** on `/login`, or opens Easy Help Desk from the Workeasy360 launcher (`https://<host>/?organization=<uuid>`; the frontend turns that into step 2 even when a session already exists).
2. `GET /api/auth/workeasy360/start?organization=&next=` generates `state`, `nonce` and a PKCE verifier (32 random bytes each). The pending flow is kept **server-side** in Redis for 10 minutes under a hash of a random flow id; the browser gets only that id, in an httpOnly, SameSite=Lax cookie (path `/api/auth/callback`; named `ds_w360_flow`, or `__Secure-ds_w360_flow` and Secure when `COOKIE_SECURE` is on). It is `__Secure-`, not `__Host-`, because `__Host-` requires `Path=/` and this cookie is deliberately never sent anywhere but the callback. `organization` is forwarded only when it is a UUID; `next` is validated (see below). The browser is redirected to the discovered authorization endpoint.
3. The person signs in at Workeasy360 (including any second factor). Workeasy360 checks membership, that the organization has Easy Help Desk (trial or paid) and the seat, and redirects to `GET /api/auth/callback/workeasy360?code=...&state=...`.
4. The callback:
   - consumes the flow first (Redis `GETDEL`), whatever happens next: a flow is good for one callback;
   - maps a provider `error` to a fixed code; a missing state, no pending flow or a state that differs (compared in constant time) is `expired`;
   - exchanges the code with a `private_key_jwt` assertion (iss = sub = client id, aud = token endpoint, `jti`, 60 s) and the PKCE verifier;
   - verifies the ID token offline: key by `kid` from the cached JWKS (one refresh on an unknown `kid`, at most every 10 s), algorithm allow-list RS256/ES256 only, `iss`, `aud` = our client id, `exp`/`nbf`/`iat` with 30 s leeway, `iss sub aud exp iat jti typ` required, `typ` = `id_token`, nonce in constant time, `organization_id` present;
   - refuses `wrong_product` (`product_code` is not `WORKEASY360_PRODUCT_CODE`) and `wrong_organization` (the launcher named one organization and the token names another);
   - provisions the person (next section);
   - ends any session this browser already holds (account switching, below), issues a fresh one, and redirects to `FRONTEND_URL` + the validated `next` (default `/dashboard`).
5. The frontend then does what it always does: `POST /auth/refresh` with the cookie, then `GET /auth/me`.

Every failure is a `302` to `FRONTEND_URL/login?sso_error=<code>`, with no session. The vocabulary is fixed: `cancelled`, `expired`, `unavailable`, `refused`, `rate_limited`, `not_entitled`, `no_seat`, `provider_membership_inactive`, `organization_inactive`, `access_policy`, `email_missing`, `email_unverified`, `account_conflict`, `account_disabled`, `membership_inactive`, `wrong_product`, `wrong_organization`. Logs carry the code and ids, never an authorization code, token, state or nonce (and the request logger drops the query string of the callback).

**`next`** must be a same-site path: it starts with `/` but not `//`, has no whitespace, control character or backslash anywhere (a browser strips a tab, so `/<tab>/evil.example` would become `//evil.example`), is at most 2,048 characters and is not an auth page or the API. Anything else lands on `/dashboard`.

## Who gets what (provisioning)

The federated identity is `(issuer, sub)` inside the Help Desk organization bound to the token's `organization_id`. The email is profile data. A Help Desk user belongs to exactly one organization, so one Workeasy360 person in two organizations is two users, each with its own `external_identities` row.

| Situation | Result |
|---|---|
| Known Workeasy360 account (issuer + `sub` in that organization) | The same user, whatever their address became. Deactivated or deleted: `account_disabled` |
| Workeasy360 organization not seen before | A new Help Desk organization through the same provisioning that registration uses (system roles, business hours, default department, ticket and SLA defaults, help center), named from `organization_name` (fallback "My organization"), with a free slug. The person becomes **SUPER_ADMIN** |
| Organization already bound | The person joins it |
| New person, address **not** verified at Workeasy360 | `email_unverified`. It neither links an account nor creates one. No address: `email_missing` |
| New person, a Help Desk **agent** has the same verified address in that organization | Linked to that user (the role the administrator gave is kept). The local password is removed and every refresh token it issued is revoked: Help Desk never verified that address, so whoever chose the password may not be the person Workeasy360 vouched for |
| ... that user is a **customer** | `account_conflict` (a sign-in never turns a customer into an agent) |
| ... that user is already linked to another Workeasy360 account | `account_conflict` |
| ... that user is deactivated or deleted | `account_disabled` |
| New person, verified address nobody has | A new AGENT with `WORKEASY360_DEFAULT_ROLE` (default `AGENT`; `ADMIN` or `LIGHT_AGENT` also allowed; never `SUPER_ADMIN`), no password, address marked verified |
| The bound organization was deleted | `organization_inactive` |
| Two first sign-ins racing | The unique constraints decide; the loser looks again once and joins (or `account_conflict` if a concurrent sign-in linked something different) |

Administrators can still pre-provision agents (name, roles, departments) with a user created without a password: they sign in through Workeasy360 and are linked by verified address. In SSO-only mode creating a user does not send an invitation email.

### Attaching an existing organization

An organization that already lives in Help Desk must be bound to its Workeasy360 organization **before** its first Workeasy360 sign-in, or that sign-in creates a new, empty organization:

```
pnpm --filter @digisoft/api build          # once; production images already contain the build
pnpm --filter @digisoft/api run link-workeasy360-organization <helpdeskOrgId> <workeasy360OrgId>
```

In the production image: `docker compose -f docker-compose.prod.yml exec api node dist/scripts/link-workeasy360-organization.js <helpdeskOrgId> <workeasy360OrgId>`. It refuses an organization already bound to a different Workeasy360 organization and a Workeasy360 organization another Help Desk organization already holds. Its agents are linked at their own first sign-in. Sessions already open pick the binding up at their next token refresh (up to 15 minutes).

## Registering Easy Help Desk with Workeasy360 (once per environment)

1. Generate Help Desk's key pair. Keep the private key secret and outside the repository:
   ```
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out helpdesk-w360.key
   openssl pkey -in helpdesk-w360.key -pubout -out helpdesk-w360.pub
   ```
   (An EC P-256 key works too: the algorithm, RS256 or ES256, is derived from the key.)
2. In the Workeasy360 repository, as a platform operator, register the integration (replaces the redirect URIs and scopes, registers the **public** key as a `private_key_jwt` credential, activates it, and prints the issuer, client id and key id):
   ```
   manage.py connect_product_sso --actor <staff email> --product easy_helpdesk \
       --redirect-uri https://help.workeasy360.com/api/auth/callback/workeasy360 \
       --public-key-file helpdesk-w360.pub
   ```
   The product is registered `sso_only`, with post-logout URI `https://help.workeasy360.com/login` and scopes `openid email profile organization`. The redirect URI is compared as an exact string: a trailing slash breaks it.
3. Set the environment of **both** the API and the worker (see below). To rotate the key, add a second credential with the command above, deploy the new key and `WORKEASY360_KEY_ID`, confirm sign-in works, then revoke the old credential.

## Environment

| Variable | API | Worker | Value |
|---|---|---|---|
| `WORKEASY360_ISSUER` | yes | yes | The issuer, exactly as its discovery document names it (no trailing slash). https in production |
| `WORKEASY360_CLIENT_ID` | yes | yes | The integration's client id |
| `WORKEASY360_REDIRECT_URI` | yes | - | The registered redirect URI. https in production |
| `WORKEASY360_KEY_ID` | yes | yes | The credential id returned when the public key was registered |
| `WORKEASY360_PRIVATE_KEY_FILE` or `WORKEASY360_PRIVATE_KEY` | yes | yes | The private key: a file path, or inline PEM (literal backslash-n sequences allowed, for a one-line variable) |
| `WORKEASY360_PRODUCT_CODE` | yes | - | Default `easy_helpdesk` |
| `WORKEASY360_SCOPES` | yes | - | Default `openid email profile organization` |
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | yes | - | Optional; registered in Workeasy360. Enables "Sign out of Easy Help Desk and Workeasy360" |
| `WORKEASY360_DEFAULT_ROLE` | yes | - | Default `AGENT` (`ADMIN`, `AGENT`, `LIGHT_AGENT`) |
| `WORKEASY360_SIGN_IN_RATE_LIMIT` | yes | - | Sign-in starts and callbacks per client address per minute, each route; default 30. People behind one shared (NATed) address - an office - share that budget: raise it (for example 300) and the `rate_limited` message disappears |
| `REALTIME_ACCESS_RECHECK_SECONDS` | yes | - | How often an open realtime socket re-checks its person's access (default 60) |
| `WORKEASY360_SSO_ONLY` | yes | yes | `1`/`true`/`yes`/`on`. Default **on in production, off elsewhere**. While on, the API and worker **refuse to start** unless the first five are set |

`deploy/.env.example` holds all of them; `docker-compose.prod.yml` hands the same file to the API and the worker. In production the private key is loaded and parsed at boot, so a missing or unreadable key file stops the deployment from starting instead of failing requests later. Elsewhere it is read at first use; an unusable key then makes the sign-in routes answer `unavailable` and the entitlement checks behave like an outage of Workeasy360 (the last answer stands; with none, access continues) - never a 500. The cookie `ds_refresh` is now scoped to `/api` (it was `/api/v1/auth`): the callback sits outside the versioned prefix and has to see it to end a previous session. Every write also expires the old path, so a browser never holds two.

**nginx:** the shipped template already keeps the sign-in routes' query strings (the callback's `?code=&state=`, the start redirect's state and nonce) out of the access log: `location /api/auth/` logs with a format that records `$uri`, never `$request_uri`. The application logger likewise drops the callback's query, the `Location` header of redirects and the query of any logged 5xx. If you run another proxy in front, give it the same rule. The API also refuses non-https discovery endpoints in production (the same rule as the issuer).

## After sign-in: access is re-checked

Workeasy360 checks the trial or plan at sign-in. The Help Desk session then lives on (its refresh token rotates), so the API asks Workeasy360's entitlement API, on a cadence, whether the organization and the person may still use it. Access tokens of Workeasy360-linked organizations carry `w360: { org, sub }` so the check needs no database query. A global guard after the token is resolved:

| Answer | Result |
|---|---|
| `deny` | `403 WORKEASY360_ACCESS_ENDED` with `details.reason` (`expired`, `suspended`, `not_entitled`, `membership_inactive`, `no_seat`) |
| `allow` without `write_allowed` | reads work; writes are `403 WORKEASY360_READ_ONLY` (a POST that only reads, such as a report export, is marked and still works) |
| Workeasy360 refused our own client (400/401/403: revoked credential, suspended integration) | `403 WORKEASY360_ACCESS_UNVERIFIED`, logged as an error. The refusal is **client-wide** (below) |
| outage (5xx, 429, timeout, network, misconfigured discovery, unreadable key) | never a denial: the last answer stands; with none, access continues |

The session itself stays valid: the frontend sends the person to `/access-ended` ("Try again", "Sign out") and `GET /auth/me`, refresh, logout, the methods read, health and the sign-in routes stay available. A request authenticated with an API key is checked at the organization level. A help center whose organization's access ended answers every portal request `403 HELP_CENTER_UNAVAILABLE`: an expired product is not served to anyone, customers included.

Cadence (identical in the API and the worker; shared package `@digisoft/workeasy360`):

- an `allow` is trusted for `min(revalidate_after, 900 s)`, at least 30 s;
- a **person's** denial is re-asked after 60 s, so a renewal takes effect quickly; a **background** denial after 900 s, so an expired organization's jobs do not cost a question a minute;
- after a failed attempt the next one waits 60 s;
- a refusal of our own client marks the **whole client** refused for 60 s (Redis and per process): during that window every question - person, organization, background - fails closed without asking, even where a fresh `allow` is cached, and a 429 received within **five minutes of the last refusal** counts as a refusal (renewing those five minutes), because Workeasy360's client-authentication failure limiter answers 429 after a few failures a minute - the one question after the 60 s mark would otherwise read it as an outage and let every cached answer resume while the credential is still revoked. A 429 with no refusal in the last five minutes is an outage. After 60 s one question is asked; until one is answered the client stays closed;
- a known denial never lapses into access: it is kept without expiry in Redis and in each process, so a Redis outage or eviction cannot hand access back; one process asks while the others use the last answer, but a first check is never waved through because another is asking.

The worst case after access ends is one window (15 minutes) for every cause: an entitlement denial, an organization suspension, a removed member, a disabled account, a removed seat, an expired trial. Only organizations bound to Workeasy360 are ever asked about; a Help-Desk-only organization has no Workeasy360 entitlement to lose.

## Background work

A job that produces a business effect re-checks the organization's entitlement (organization level, no person, writes allowed) right before producing it. Denied: the effect is skipped, `workeasy360.background_skipped` is logged (organization, job, reason), and the job completes **without throwing**, so it is not retried in a loop. Nothing is deleted or re-scheduled: work resumes with the next event after renewal.

| Work | Where | Class | Rule |
|---|---|---|---|
| Automation and escalation rules | worker `automation` | **A** | checked before the rules run |
| Outbound channel replies (email, messaging) | worker `channel` | **A** | checked before sending |
| Outbound webhooks | worker `webhook` | **A** | skipped; the delivery stays `PENDING` and can be replayed after renewal |
| AI analysis | worker `ai` | **A** | checked before spending the AI budget |
| In-app notifications | worker `notifications` | **A** | checked before creating one |
| SLA warnings and breaches (global scan) | worker `sla` | **A** | each distinct organization is checked once per sweep; a denied organization's tickets are left untouched and unstamped, so they are raised after renewal. The escalation automations they would enqueue are gated again |
| Email produced by an automation (`send_email`) or a satisfaction survey | worker `email`, jobs carry `requiresAccess` | **A** | checked before sending |
| Account-security email (password reset, verification, password changed, invitations) | worker `email`, no flag | - | never held back; refused earlier in SSO-only mode |
| Finishing a report export that was already requested | worker `analytics` | **B** | cleanup: no check. A new export request after access ended is refused at the API (a read-only organization may still request one: data portability) |
| Expiring unanswered satisfaction surveys | worker `analytics` (rollup pass) | **B** | no check |
| Metric rollups | worker `analytics` | **C** | retention and system maintenance: no check |
| Session and token expiry, deletion | API / database | **B** | no check |

The worker needs the same `WORKEASY360_*` values as the API (not the redirect URI). Without them it does not gate anything, which is why it refuses to start in production while SSO-only is on.

## Signing out, and signing in as someone else

- **Sign out** ends the Help Desk session (the refresh token family is revoked).
- **Sign out of Easy Help Desk and Workeasy360** (offered when `WORKEASY360_POST_LOGOUT_REDIRECT_URI` is set) ends the Help Desk session first, then navigates to `GET /api/auth/workeasy360/logout`, which redirects to the discovered `end_session_endpoint?client_id=&post_logout_redirect_uri=`. Workeasy360 asks the person to confirm and returns them to the registered URI. That route changes nothing locally, so a link to it cannot sign anyone out of Help Desk. Other products' sessions are not ended.
- **Account switching / session fixation:** when a sign-in completes in a browser that already holds a refresh cookie, that cookie's session family is revoked on the server before the new one is issued, so the previous person is signed out properly rather than overwritten in the cookie jar, and a pre-set cookie is never reused. A failed sign-in leaves the existing session alone.
- There is no front- or back-channel logout from Workeasy360: while the Workeasy360 session is alive, the next Continue with Workeasy360 signs straight back in.

## SSO-only mode

With `WORKEASY360_SSO_ONLY` on, the API answers `403 PASSWORD_SIGN_IN_DISABLED` for agent `login`, `register`, `forgot-password`, `reset-password`, `change-password`, setting a password when creating a user, and `POST /users/:id/invite`; `GET /auth/register` reports `enabled: false`; and `GET /auth/methods` reports `{ password: false, workeasy360: true, workeasy360SignOut }`. The login page then shows only **Continue with Workeasy360** (no form, no register or forgot-password links, never an automatic redirect) and a message for each `sso_error` code. Customer portal sign-in, sign-up and password reset are unaffected.

**Sessions that predate SSO-only.** Every refresh token records how its session was started (`PASSWORD` or `WORKEASY360`). In SSO-only mode an agent session in an organization bound to Workeasy360 whose user has no Workeasy360 identity is refused on every non-public route with `403 WORKEASY360_SIGN_IN_REQUIRED`, and `POST /auth/refresh` refuses password-method families and unlinked accounts with the same code (the frontend sends the person to the sign-in page with an explanation; signing in with Workeasy360 links the account by verified email and ends what the password issued). API keys stay at the organization level, development (SSO-only off) keeps today's behaviour, and customers' help center sessions are not affected. `link-workeasy360-organization` revokes the organization's existing agent refresh tokens when it binds it, and linking an account invalidates its outstanding password-reset and invitation links.

**Customers keep passwords.** The help center has its own reset route, `POST /api/v1/portal/<slug>/auth/reset-password`, which accepts only a password-reset token of a customer of that help center (an agent's token, an invitation token or another help center's token look like an invalid link and are not consumed); the agent route stays off. The help center's forgot-password mails customers only.

Agent routes also now require an agent token: a help center customer's token (same shape, own cookie) is refused with `403 FORBIDDEN` on every agent route, including those that ask for no permission such as `GET /auth/me`.

## Local development

`NODE_ENV=development` leaves SSO-only off, so password sign-in keeps working with no Workeasy360 running and `GET /auth/methods` reports `workeasy360: false`. To rehearse the real flow, register a development integration whose redirect URI is `http://localhost:4000/api/auth/callback/workeasy360` (Workeasy360 accepts `http://localhost` outside production), fill in `backend/.env`, and set `WORKEASY360_SSO_ONLY=false` (both ways in) or `true`. The frontend's `NEXT_PUBLIC_API_URL` origin is where Continue with Workeasy360 points, so in development the callback lands on the API's port and then redirects to `FRONTEND_URL`.

## Limits

- The check on a signed-in request is per person, once per window, so the worst case after access ends is one window (15 minutes), not the life of the session.
- Realtime (Socket.IO): the `/rt` channel is for agents only (a customer's token is refused). A socket is checked at connect and again every `REALTIME_ACCESS_RECHECK_SECONDS` (default 60) through the same cached decision HTTP requests use, so a person whose access ended (or who must sign in with Workeasy360) receives `access.ended` and is disconnected within one re-check, even though `POST /auth/refresh` stays public and keeps minting tokens for them (the access-ended screen needs it). An outage of Workeasy360 never disconnects anyone.
- A denied organization's overdue SLA tickets are left out of the scan's queries until its denial is due to be asked again (15 minutes; a minute for a refusal), and the skip is logged when it begins or changes, not on every sweep.
- Inbound provider webhooks that create tickets without an agent (`/api/v1/webhooks/...`) are not refused for an organization whose access ended; the help center's own routes (including the chat widget) are. What it triggers (automations, replies, notifications, webhooks, AI, SLA) is gated in the worker.
- Redis 6.2 or newer is required (`GETDEL`).
- Entitlement answers and sign-in flows need Redis; without it sign-in fails closed (`unavailable`).
