# Sign in with Workeasy360

**Written for: whoever deploys or operates Easy Help Desk.**

Easy Help Desk is a Workeasy360 product. Agents sign in with their Workeasy360 account; the Help Desk never sees their password. With `WORKEASY360_SSO_ONLY` on (the default in production) it is the only way agents get in: password sign-in, self-registration, password reset and invitation emails are switched off, because people, plans and organizations are managed in Workeasy360. The customer portal (the `/help/<slug>` help center and its customer accounts) is separate and unchanged.

The protocol is OpenID Connect authorization code with PKCE and `private_key_jwt` client authentication, as laid out in Workeasy360's product integration guide. Nothing here needs a change to nginx: the sign-in routes live under `/api/auth/`, which the `/api/` rule already sends to the API.

## How a sign-in works

1. The person clicks **Continue with Workeasy360** on `/login`; or opens Easy Help Desk from the Workeasy360 launcher (`https://<host>/?organization=<uuid>`; the frontend turns that into step 2 even when a session already exists); or, when sign-in is Workeasy360 only, simply types the address of any agent page with no session (see "Opening Easy Help Desk directly" below: the frontend starts step 2 itself).
2. `GET /api/auth/workeasy360/start?organization=&next=` generates `state`, `nonce` and a PKCE verifier (32 random bytes each). The pending flow is kept **server-side** in Redis for 10 minutes under a hash of a random flow id; the browser gets only that id, in an httpOnly, SameSite=Lax cookie. Over plain http (development, tests) it is `ds_w360_flow` on path `/api/auth/callback`. With `COOKIE_SECURE` on (production) it is **`__Host-ds_w360_flow`**: Secure, `Path=/`, no Domain, and only that name is read at the callback (see "Cookie names" under Environment). `organization` is forwarded only when it is a UUID; `next` is validated (see below). The browser is redirected to the discovered authorization endpoint.
3. The person signs in at Workeasy360 (including any second factor). Workeasy360 checks membership, that the organization has Easy Help Desk (trial or paid) and the seat, and redirects to `GET /api/auth/callback/workeasy360?code=...&state=...`.
4. The callback:
   - consumes the flow first (Redis `GETDEL`), whatever happens next: a flow is good for one callback;
   - maps a provider `error` to a fixed code; a missing state, no pending flow or a state that differs (compared in constant time) is `expired`;
   - exchanges the code with a `private_key_jwt` assertion (iss = sub = client id, aud = token endpoint, `jti`, 60 s) and the PKCE verifier;
   - verifies the ID token offline: key by `kid` from the cached JWKS (one refresh on an unknown `kid`, at most every 10 s), algorithm allow-list RS256/ES256 only, `iss`, `aud` = our client id, `exp`/`nbf`/`iat` with 30 s leeway, `iss sub aud exp iat jti typ` required, `typ` = `id_token`, nonce in constant time, `organization_id` present;
   - refuses `wrong_product` (`product_code` is not `WORKEASY360_PRODUCT_CODE`) and `wrong_organization` (the launcher named one organization and the token names another);
   - provisions the person (next section);
   - ends any session this browser already holds (account switching, below);
   - records, for back-channel logout, which session it is about to open (the new refresh-token family), for whom (`issuer`, `sub`) and under which Workeasy360 sign-in (the ID token's `sid`, when Workeasy360 issued one; see "Signed out at Workeasy360" below);
   - issues the fresh session, and redirects to `FRONTEND_URL` + the validated `next` (default `/dashboard`).
5. The frontend then does what it always does: `POST /auth/refresh` with the cookie, then `GET /auth/me`.

Every failure is a `302` to `FRONTEND_URL/login?sso_error=<code>`, with no session. The vocabulary is fixed: `cancelled`, `expired`, `unavailable`, `refused`, `rate_limited`, `not_entitled`, `no_seat`, `provider_membership_inactive`, `organization_inactive`, `access_policy`, `email_missing`, `email_unverified`, `account_conflict`, `account_disabled`, `membership_inactive`, `wrong_product`, `wrong_organization`. Logs carry the code and ids, never an authorization code, token, state or nonce (and the request logger drops the query string of every `/api/auth/` request: the callback's `code` and `state`, and the start's `next`, which can carry the opened page's query).

**`next`** must be a same-site path: it starts with `/` but not `//`, has no whitespace, control character or backslash anywhere (a browser strips a tab, so `/<tab>/evil.example` would become `//evil.example`), is at most 2,048 characters and is not an auth page or the API. Anything else lands on `/dashboard`.

## Opening Easy Help Desk directly (SSO-only)

Someone who is signed in to Workeasy360 and types `https://help.workeasy360.com/` (or any agent page) must arrive signed in, without the Help Desk's sign-in page and without a password: section 6b of Workeasy360's product integration guide (`docs/phase-3/09-product-integration-guide.md`) and `docs/universal-sso/one-login.md` in that repository.

**What happens.** With `GET /auth/methods` reporting `password: false, workeasy360: true` (SSO-only), an agent app page opened by a browser with **no session at all** goes straight to `<API origin>/api/auth/workeasy360/start?next=<that page>` (a `window.location.replace`, so the page that needed a session does not stay in the history; no organization is named). Workeasy360 then completes silently when its own session exists and the person's preference is Automatic (the default), asks first when it is "Ask me each time", and shows its central sign-in when there is no Workeasy360 session. The callback, provisioning and the access checks are unchanged. Meanwhile the page shows a neutral "Signing you in with Workeasy360..." state (one `h1`), not the sign-in page.

**Where.** In the browser, in the agent app's session bootstrap (`frontend/hooks/use-session.ts`, used by `app/(app)/layout.tsx`): the refresh cookie is `httpOnly`, and over plain http it has path `/api` (in production it is `__Host-ds_refresh` at `Path=/`, which the frontend never reads either), so the page asks the API whether a session exists rather than looking for a cookie. The decision and its two cookies are in `frontend/lib/auto-sign-in.ts`; the start URL is built the same way as the **Continue with Workeasy360** button (`lib/sso.ts`), so in production it is the same origin (nginx `/api/`) and in development the API's origin. `next` is the opened page's path and query, checked with the API's rule (below); one that does not pass is left out and the API lands on `/dashboard`. `/` is redirected to `/dashboard` first, so it starts with `next=/dashboard`.

**Only "no session at all".** A start happens only when `POST /auth/refresh` answers **401** (no refresh cookie, or the session is gone) while a page loads, and `/auth/methods` says SSO-only. Everything else keeps today's behaviour, and a session is never replaced silently:

| What the page finds | Result |
|---|---|
| Refresh 401, SSO-only | Starts the Workeasy360 sign-in |
| Refresh 401, password sign-in also on (or `/auth/methods` unreadable) | `/login?next=<page>`, as before |
| Refresh 403 `WORKEASY360_SIGN_IN_REQUIRED` (a password-era session) | `/login?signin=workeasy360`, with its explanation |
| Refresh works, then a 403 `WORKEASY360_ACCESS_ENDED`, `READ_ONLY` or `ACCESS_UNVERIFIED` | `/access-ended`, with Try again and the two sign-outs |
| Refresh fails any other way (outage, throttle) | `/login?next=<page>`: we do not know that there is no session |
| A session lost while the app is open (an API call's 401, then a failed refresh) | `/login?next=<page>`: API calls are never redirected, and nothing starts a sign-in in the middle of work |
| Customer help center pages (`/help/<slug>/...`) | Unchanged: they have their own sign-in |

**Never by itself.** The sign-in page is where a person chooses, so:

- **`/login` never starts anything**, whatever its query, including `?sso_error=` and `?signin=`: it shows **Continue with Workeasy360** and waits to be clicked. The other sign-in pages and `/access-ended` start nothing either.
- **After signing out of the Help Desk in this browser.** Both entries, **Sign out** and **Sign out of Easy Help Desk and Workeasy360**, write the marker cookie **`hd_signed_out`** (value `1`, `Path=/`, `SameSite=Lax`, **no `Max-Age` or `Expires`**: a session cookie, so every tab sees it and it ends with the browser session; over https it is `__Host-hd_signed_out` and `Secure`). While it stands, opening the Help Desk shows the sign-in page, so a sign-out never ends in a silent sign-in through a Workeasy360 session that is still alive.
  - It is written **before** the sign-out request is sent, so no other tab can start a sign-in in the gap. It is taken back only if the server clearly refused (a 4xx other than 401, 408 and 429: the person is still signed in). On a 401 (there is no session left to end), a network error or a 5xx it stays: the session may well be gone.
  - It is cleared **only by a real sign-in**: the API's Workeasy360 callback expires it with a `Set-Cookie` on success (`__Host-hd_signed_out` under `COOKIE_SECURE`, `hd_signed_out` otherwise; the frontend and the API share a host, behind nginx in production, and cookies ignore ports in development), and the password form or registration clears it in the browser. A refresh that merely succeeded does **not** clear it, because another tab may be signing out at that moment. (If the API is on a different host from the app, the callback cannot reach the app's cookie and the marker simply lasts until the browser closes: the sign-in page is shown instead of an automatic start, which is the safe direction.)
- **Loop guard.** Right before an automatic start the page writes **`hd_w360_auto`** (the time in milliseconds, `Max-Age=60`; `__Host-hd_w360_auto` over https). If it is still there, and under 60 seconds old, when a page finds no session again, the sign-in page is shown instead: a dropped cookie, or a failure that was not reported as `sso_error`, can never spin. A found session or a sign-in clears it. If the browser will not keep the cookie, nothing is started automatically at all.

Over http the page reads **every** cookie of those names: the marker is set if any copy says `1`, and the guard is active if any copy is recent, so a copy planted under another path or domain cannot hide either. Over https they are `__Host-` cookies (Secure, `Path=/`, never a Domain), which a sibling subdomain cannot plant or shadow, and only that name is read.

Neither cookie grants anything; removing one only changes whether a start is tried. They are written by the page (not `httpOnly`) on the app's own origin and travel to the API like any cookie of the same host, which ignores them.

**If it takes long.** The "Signing you in with Workeasy360..." screen shows the same start link as the sign-in page's button (**Continue with Workeasy360**) and a **Go to the sign-in page** link after about five seconds, and announces that it is taking longer than expected.

**`next` validation** is the API's `safeNext` rule, applied in the browser too so that a hostile address is never forwarded: it starts with `/` but not `//`, has no whitespace, control character or backslash, is at most 2,048 characters and is not a sign-in page or the API. The API validates it again.

Not SSO-only (development, or password sign-in deliberately on): nothing changes. No session means `/login`, which offers both ways in.

## Who gets what (provisioning)

The federated identity is `(issuer, sub)` inside the Help Desk organization bound to the token's `organization_id`. The email is profile data. A Help Desk user belongs to exactly one organization, so one Workeasy360 person in two organizations is two users, each with its own `external_identities` row.

| Situation | Result |
|---|---|
| Known Workeasy360 account (issuer + `sub` in that organization) | The same user, whatever their address became. Deactivated or deleted: `account_disabled` |
| Workeasy360 organization not seen before | A new Help Desk organization through the same provisioning that registration uses (system roles, business hours, default department, ticket and SLA defaults, help center), named from `organization_name` (fallback "My organization"), with a free slug. The person becomes **SUPER_ADMIN** |
| Organization already bound | The person joins it |
| New person, address **not** verified at Workeasy360 | `email_unverified`. It neither links an account nor creates one. No address: `email_missing` |
| New person, a Help Desk **agent** (any role: `SUPER_ADMIN`, `ADMIN`, `AGENT`, `LIGHT_AGENT` or a custom one) has the same verified address in that organization | `account_conflict`, with "contact your administrator to have it linked". **Never merged automatically**, whoever verified the address and whatever `WORKEASY360_LINK_BY_VERIFIED_EMAIL` says. The account is left exactly as it was (password, roles, sessions), and the refusal is written to the organization's audit log as `user.workeasy360_link_refused` with the issuer and `sub` that asked. An operator links the two with `link-workeasy360-user` once someone has confirmed they are the same person ("Linking an existing account", below) |
| ... that user is a **customer** | `account_conflict` (a sign-in never turns a customer into an agent) |
| ... that user is already linked to another Workeasy360 account | `account_conflict` |
| ... that user is deactivated or deleted | `account_disabled` |
| New person, verified address nobody has | A new AGENT with `WORKEASY360_DEFAULT_ROLE` (default `AGENT`; `ADMIN` or `LIGHT_AGENT` also allowed; never `SUPER_ADMIN`), no password, address marked verified |
| The bound organization was deleted | `organization_inactive` |
| Two first sign-ins racing | The unique constraints decide; the loser looks again once and joins (or `account_conflict` if a concurrent sign-in linked something different) |

**Pre-provisioned agents.** An agent an administrator creates in Help Desk (name, roles, departments) is an existing account like any other: their first Workeasy360 sign-in is `account_conflict` until an operator links them. With Workeasy360 the simpler path is not to pre-create anyone: the person's first sign-in creates them with `WORKEASY360_DEFAULT_ROLE`, and an administrator then changes their role. In SSO-only mode creating a user does not send an invitation email.

### Attaching an existing organization

An organization that already lives in Help Desk must be bound to its Workeasy360 organization **before** its first Workeasy360 sign-in, or that sign-in creates a new, empty organization:

```
pnpm --filter @digisoft/api build          # once; production images already contain the build
pnpm --filter @digisoft/api run link-workeasy360-organization <helpdeskOrgId> <workeasy360OrgId>
```

In the production image: `docker compose -f docker-compose.prod.yml exec api node dist/scripts/link-workeasy360-organization.js <helpdeskOrgId> <workeasy360OrgId>`. It refuses an organization already bound to a different Workeasy360 organization and a Workeasy360 organization another Help Desk organization already holds. Its existing agents are not linked by it: link each one with `link-workeasy360-user` (next section); until then their Workeasy360 sign-in is `account_conflict`. The agents' sessions already open end when it binds (their refresh tokens are revoked, and with them their access tokens); each agent signs in again through Workeasy360 once linked.

### Linking an existing account (operator)

The only way an existing Help Desk account is joined to a Workeasy360 account is an operator vouching that they are the same person (confirmed with the person, or by the organization's owner), with the person's Workeasy360 `sub`. The `sub` is in the `user.workeasy360_link_refused` audit entry the person's refused sign-in wrote, or comes from Workeasy360; never take it from an email alone.

```
pnpm --filter @digisoft/api run link-workeasy360-user \
  --email ada@acme.example --subject <Workeasy360 sub> --organization <workeasy360OrgId> \
  --actor "ops@workeasy360.com" --reason "OPS-123: confirmed with Ada by phone"
```

In the production image: `docker compose -f docker-compose.prod.yml exec api node dist/scripts/link-workeasy360-user.js --email ... --subject ... --organization ... --actor ... --reason ...`. The issuer is `WORKEASY360_ISSUER` (or `--issuer`).

- The account is looked up **inside the Help Desk organization bound to that Workeasy360 organization** (link the organization first); an account in another organization is not found.
- It refuses, changing nothing: a missing `--actor` or `--reason`; a customer; a deactivated or deleted account; an account already linked to another Workeasy360 account (under this issuer, or another `sub` under an earlier one); and a Workeasy360 account already linked to someone else in the organization. Exactly the same link again is a no-op.
- Staff and administrators (`SUPER_ADMIN` included) may be linked this way: that is what the command is for.
- It writes `user.workeasy360_linked` to the organization's audit log, `actorType` `SYSTEM`, with `method: operator`, the operator (`--actor`), the reason, the issuer, `sub`, Workeasy360 organization, the account's address and the time.
- It revokes the account's refresh tokens (the sessions its password opened, and with them their access tokens); the person's next session is the one Workeasy360 opens.
- **The password is left as it is** (and so is any reset or invitation link already mailed): existing sign-in data is not removed before the migration and linking have been tested. In SSO-only mode none of it opens anything (below); outside it, the account keeps both ways in.

### Automatic linking by verified address (`WORKEASY360_LINK_BY_VERIFIED_EMAIL`)

Off by default, and best left off. In the other WorkEasy360 products it lets a sign-in link an unlinked account of the same organization when Workeasy360 says the address is verified (never across organizations, never an account already linked, audited). **Help Desk never links a staff account automatically, even with it on**, and every account a Workeasy360 sign-in can open is a staff account (an agent: `SUPER_ADMIN`, `ADMIN`, `AGENT`, `LIGHT_AGENT` or a custom role, any of which can carry administration or customer data; customers are refused as before). So turning it on changes nothing in Help Desk today: the answer is still `account_conflict`, the audit entry's reason says `staff_never_auto_linked`, and staff accounts link only through `link-workeasy360-user`.

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
4. Optional, once a release with the receiver is deployed: register the back-channel logout URL, `https://help.workeasy360.com/api/auth/workeasy360/backchannel-logout`, so that signing out of Workeasy360 also ends Help Desk sessions (see "Signed out at Workeasy360: back-channel logout").

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
| `WORKEASY360_LINK_BY_VERIFIED_EMAIL` | yes | - | Default **off**. Never links a staff account in Help Desk, so it has no effect today ("Automatic linking by verified address") |

`deploy/.env.example` holds all of them; `docker-compose.prod.yml` hands the same file to the API and the worker. In production the private key is loaded and parsed at boot, so a missing or unreadable key file stops the deployment from starting instead of failing requests later. Elsewhere it is read at first use; an unusable key then makes the sign-in routes answer `unavailable` and the entitlement checks behave like an outage of Workeasy360 (the last answer stands; with none, access continues) - never a 500. The refresh cookie and the Workeasy360 flow cookie are `__Host-` cookies in production; see "Cookie names" below.

### Cookie names

All of the products are siblings under one parent domain, so a compromised sibling (say, XSS on another product's host) can set a cookie with `Domain=.parent` that this origin receives. A `__Secure-` prefix does not stop that; only `__Host-` does, because a browser refuses a `__Host-` cookie that has a Domain, a path other than `/`, or no `Secure`, so only this exact host can have set it. Planting a flow cookie (and then sending the victim to the callback with the attacker's code and state) or a refresh cookie would sign the victim in as the attacker, so the names are chosen by `COOKIE_SECURE`, and **only the chosen name is read**:

| Cookie | Plain http (development, tests; `COOKIE_SECURE` off) | `COOKIE_SECURE` on (production) |
|---|---|---|
| Agent refresh | `ds_refresh`, `Path=/api`, httpOnly, SameSite=Lax, `Domain=COOKIE_DOMAIN` if set | `__Host-ds_refresh`, `Path=/`, httpOnly, Secure, SameSite=Lax, **no Domain** |
| Workeasy360 flow | `ds_w360_flow`, `Path=/api/auth/callback`, httpOnly, SameSite=Lax, 10 minutes | `__Host-ds_w360_flow`, `Path=/`, httpOnly, Secure, SameSite=Lax, 10 minutes, **no Domain** |
| Signed-out marker (set by the page) | `hd_signed_out`, `Path=/`, session cookie | `__Host-hd_signed_out`, `Path=/`, Secure, session cookie |
| Loop guard (set by the page) | `hd_w360_auto`, `Path=/`, 60 s | `__Host-hd_w360_auto`, `Path=/`, Secure, 60 s |

Consequences: `COOKIE_DOMAIN` does not apply to the two `__Host-` cookies (it still applies to the customer help center's cookie); an unprefixed `ds_refresh` or `ds_w360_flow`, or a `__Secure-` one, is ignored in production, never trusted; reading, rotation, sign-out and clearing all use the live name, and every write also expires the unprefixed `ds_refresh` that earlier releases left at `/api` and at `/api/v1/auth`. nginx needs no change: it passes cookies through, and the `Path=/` cookies simply travel on page requests to the Next.js app too, which never reads them. Over plain http nothing changes from the previous release (`ds_refresh` is scoped to `/api`, not `/api/v1/auth`: the callback sits outside the versioned prefix and has to see it to end a previous session).

**After deploying this change, existing agent sessions sign in again once.** The old `ds_refresh` cookie is no longer read, so the next visit finds no session and (SSO-only) starts the Workeasy360 sign-in by itself, which completes silently when the person's Workeasy360 session exists and their preference is Automatic. Nobody loses data, and the old sessions expire on their own.

**nginx:** the shipped template already keeps the sign-in routes' query strings (the callback's `?code=&state=`, the start redirect's state and nonce) out of the access log: `location /api/auth/` logs with a format that records `$uri`, never `$request_uri`. The application logger likewise drops the query of every `/api/auth/` request (the callback's `code`/`state` and the start's `next`, which can carry the opened page's query), the `Location` header of redirects and the query of any logged 5xx. If you run another proxy in front, give it the same rule. The API also refuses non-https discovery endpoints in production (the same rule as the issuer).

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

A Help Desk session is a refresh-token family, and ending a session ends its access tokens with it (see "Ending a session ends its access tokens" below): whatever revokes the family, every request still carrying one of its access tokens is refused from then on.

- **Sign out** ends the Help Desk session (the refresh token family is revoked, and its access tokens are refused at once) and leaves the `hd_signed_out` marker, so opening the Help Desk afterwards shows the sign-in page instead of signing straight back in (see "Opening Easy Help Desk directly").
- **Sign out of Easy Help Desk and Workeasy360** (offered when `WORKEASY360_POST_LOGOUT_REDIRECT_URI` is set) ends the Help Desk session first (and leaves the same marker), then navigates to `GET /api/auth/workeasy360/logout`, which redirects to the discovered `end_session_endpoint?client_id=&post_logout_redirect_uri=`. Workeasy360 asks the person to confirm and returns them to the registered URI (the sign-in page). That route changes nothing locally, so a link to it cannot sign anyone out of Help Desk. Other products' sessions end only where those products receive back-channel logout.
- **Account switching / session fixation:** when a sign-in completes in a browser that already holds a refresh cookie, that cookie's session family is revoked on the server before the new one is issued, so the previous person is signed out properly rather than overwritten in the cookie jar, and a pre-set cookie is never reused. A failed sign-in leaves the existing session alone.
- **Signing out of Workeasy360** ends Help Desk sessions through back-channel logout once its URL is registered (next section). Without it, a Help Desk session lives on until it is signed out here, expires, or fails the entitlement re-check. Either way, while the Workeasy360 session is alive, the next Continue with Workeasy360 signs straight back in. Only that explicit click does: a plain visit after a sign-out shows the sign-in page until the person signs in again.

## Ending a session ends its access tokens

Every access token names its session: the claim `fam` is the refresh-token family it was issued for. Every authenticated request, every realtime handshake and every realtime re-check is served only while that family is **live**: it still holds an unrevoked refresh token and, for a session opened by Workeasy360, the sign-in that opened it has not been ended by a back-channel logout (`workeasy360_sign_ins.endedAt`). So whatever ends a session ends its access tokens at the same moment, on every API instance and across restarts, because the answer comes from PostgreSQL and nothing is kept in a process: a back-channel logout (one sign-in or "sign out everywhere"), Sign out, a password change or reset, a replayed refresh token, an account switch in the same browser, a deactivated or removed user, binding the organization with `link-workeasy360-organization`.

- **Where.** `TenantContextMiddleware` checks it once per request, before any guard, so a token whose session ended gives the request no identity and no tenant scope, as if it carried none. Agent routes and help center (portal) routes then answer `401 SESSION_ENDED` ("Your session has ended. Sign in again."), or `401 ACCOUNT_DISABLED` when the account itself has been deactivated or deleted (the more precise reason, as before); public routes that need no identity still answer. If the database cannot answer, the request is refused with `503 SERVICE_UNAVAILABLE`, never `401`, so an outage signs nobody out.
- **Cost.** One extra PostgreSQL query per authenticated request (and per realtime handshake and re-check): a single round trip with three index probes, `users` by primary key, `refresh_tokens (userId, familyId)` and the unique `workeasy360_sign_ins (familyId)`. Nothing is cached, so nothing can delay a revocation. API-key requests are not affected.
- **Realtime.** A socket joins the room of its session. When a session ends through Sign out, a back-channel logout, an account switch or a replayed refresh token, the instance that ended it publishes the family ids on Redis (`rt:session-ended`); every API instance tells that session's sockets `session.ended` and drops them at once. Anything else that ends a session (a password change, a deactivated user, the link script) is not announced: those sockets go at their next re-check (`REALTIME_ACCESS_RECHECK_SECONDS`, 60 s by default), which asks about the session first. A handshake with an ended session's token is told `session.ended` and refused.
- **The browser.** The access token is in memory only. On a `401` the app renews once (`POST /auth/refresh`); for an ended session the renewal is refused too (`401`), and the page moves to signed-out: the session is cleared, cached data dropped, and the sign-in page shown (which never starts a sign-in by itself, so there is no loop). On `session.ended` the realtime hook makes the same one renewal: refused, the page signs out without waiting for a request; granted (somebody signed in again in another tab), the socket reconnects with the new session. A page already on screen stays visible, but performs nothing more. A reload makes the same renewal and lands on the sign-in page.
- **Tokens from before this release** carry no `fam` and are refused with `401 SESSION_ENDED`; the app answers that with its usual one renewal, which mints a token that has it. Deploying therefore costs each open tab one extra refresh, not a sign-out.

## Signed out at Workeasy360: back-channel logout

When a Workeasy360 sign-in that opened Easy Help Desk ends (the person signs out of Workeasy360 or switches account there, a session is revoked, "sign out everywhere", a password change or reset), Workeasy360 tells Help Desk server to server with an OpenID Connect Back-Channel Logout 1.0 request, and Help Desk ends the sessions that sign-in opened. This is platform ADR-069; the contract is section 3.3 of `docs/phase-3/04-oidc-contract.md` in the Workeasy360 repository. Nothing happens until the URL is registered (Rollout, below): until then Workeasy360 sends nothing and its ID tokens carry no `sid`.

**The endpoint.** `POST /api/auth/workeasy360/backchannel-logout`, `application/x-www-form-urlencoded`, one field: `logout_token`. Like the callback it lives under `/api/auth`, outside the versioned prefix (`API_PREFIX`), because its address is registered with Workeasy360, which requires the origin of a registered redirect URI. nginx's `/api/auth/` rule already sends it to the API and logs it without a query string; the request logger logs no bodies, so the token never reaches a log. No cookie is read and no CSRF token is asked for: the provider's signature is the authentication. Every answer carries `Cache-Control: no-store`.

| Answer | When | Workeasy360 then |
|---|---|---|
| `200`, empty body | The token verified and the sessions it names have ended (or had already, or there were none here) | Marks the delivery delivered |
| `400 {"error":"invalid_request"}` | The token does not verify, or its `jti` was accepted before. Nothing ends | Final: a 4xx is not retried |
| `503 {"error":"temporarily_unavailable"}` | The key set could not be read, or ending the sessions failed. Nothing was recorded | Retries for about 31 hours (0 s, 15 s, 1 min, 5 min, 15 min, 1 h, 6 h, 24 h) |
| `404` | Workeasy360 sign-in is not configured in this deployment | Final |

**Verification** (`verifyLogoutToken` in `@digisoft/workeasy360`: the same client and cached key set as the ID token):

- the key is chosen by `kid` from the provider's key set (an unknown `kid` refreshes the set once, at most every 10 s), and the algorithm is **the key's** (its `alg`, or what its type implies: RS256 or ES256 only), never what the token asks for;
- the JOSE header `typ` is `logout+jwt` (or `application/logout+jwt`); a `typ` claim, when present, is `logout_token`, so an ID or access token is never taken for a logout;
- `iss` is exactly `WORKEASY360_ISSUER`; `aud` contains `WORKEASY360_CLIENT_ID` (with several audiences, `azp` must be it too);
- `iat` is at most 30 s in the future and at most 10 minutes old; `exp` has not passed (30 s of skew);
- `events` is an object holding `http://schemas.openid.net/event/backchannel-logout` as an object;
- there is **no** `nonce`; there is a `sub` and/or a `sid`, and a `jti` (each at most 255 characters);
- the `jti` is accepted once: it is stored (`workeasy360_logout_tokens`, per issuer) until the token would be refused anyway (the earlier of `exp` and `iat` + 10 minutes, plus the skew), and the receiver deletes expired rows itself, at most every 10 minutes per process. The same token delivered twice is `400`.

**What ends.** A Help Desk session is a refresh-token family. Every Workeasy360 sign-in is recorded in `workeasy360_sign_ins`: the family the callback opens, the person (`issuer`, `sub`) and the ID token's `sid` (empty when Workeasy360 issued none). Then:

- **`sid` present** (one Workeasy360 sign-in ended): the families that sign-in opened are revoked (narrowed to `sub` when the token names one too, as Workeasy360's do). The person's other devices and other Workeasy360 sign-ins keep their sessions.
- **only `sub`** ("sign out everywhere"): every unrevoked refresh token of every Help Desk user linked to (`issuer`, `sub`) is revoked: one user per organization the person works in, however each session was started.

Recording the `jti`, revoking and marking the sign-ins ended are one database transaction: all of it or none of it, so a failure answers `503` and Workeasy360's retry is accepted. Revoking a revoked session changes nothing, so a repeated delivery (each attempt carries a fresh token) is harmless. A family whose sign-in has ended is refused, for renewal and for every request, even if one of its refresh tokens escaped the revocation (a rotation in flight at that very moment), so a race cannot keep the session alive. Once the transaction has committed, the ended families are announced to every API instance (`rt:session-ended`), which drops their realtime sockets.

**What the person sees.** From the moment the logout token is accepted, every request carrying an access token of an ended session is refused with `401 SESSION_ENDED` on every API instance, although the token has not expired (see "Ending a session ends its access tokens"): agent routes, reads and writes alike, help center routes, and the realtime handshake. An open realtime socket of that session is told `session.ended` and dropped at once. The tab that was on screen stays visible but does nothing more: on `session.ended`, or at its next request's `401`, the app makes its one renewal, which is refused (`401`), and moves to the sign-in page. A reload does the same; opened afresh in SSO-only mode it starts a Workeasy360 sign-in, where the person has to sign in again because their Workeasy360 session is gone.

**Logs.** `workeasy360.backchannel_logout` (the `jti`, `by: sid | sub`, `sessionsEnded`), `workeasy360.logout_token_rejected` (our reason, never the token), and, as errors, `workeasy360.logout_token_unverifiable` (key set or discovery unreadable) and `workeasy360.backchannel_logout_failed` (the database), both answered `503`.

**Rollout.**

1. Deploy a release with the receiver. Migration `20261117170619_workeasy360_backchannel_logout` only adds two tables (`workeasy360_sign_ins`, `workeasy360_logout_tokens`); no existing table changes. There is no new setting: the receiver uses the `WORKEASY360_*` values already set. Until step 2 nothing visible changes (sign-ins are recorded without `sid`), except that access tokens issued by the previous release name no session and are refused once with `401 SESSION_ENDED`: each open tab renews transparently (one extra refresh, nobody is signed out).
2. In Workeasy360 Super Admin: Product Manager, Easy Help Desk, **Integration**, *Authentication & credentials*, **Edit authentication**, **Back-channel logout URL**: `https://help.workeasy360.com/api/auth/workeasy360/backchannel-logout`. It must be https, on the origin of a registered redirect URI (`https://help.workeasy360.com/api/auth/callback/workeasy360`), without query or fragment; saving stamps manifest `2026-11-15`. Another deployment registers `https://<its host>/api/auth/workeasy360/backchannel-logout`.
3. Check it: sign in to Help Desk through Workeasy360 (that session now has a `sid`), sign out of Workeasy360, and see the delivery as delivered on the **Back-channel logout** card in Super Admin, `workeasy360.backchannel_logout` with `sessionsEnded: 1` in the API log, the open Help Desk tab sent to the sign-in page at once (its realtime socket is told `session.ended`) or at its next request, and its access token answered `401 SESSION_ENDED` by `GET /api/v1/auth/me`.

Sessions opened before step 2 have no `sid`: a logout naming one sign-in cannot find them, though a `sub`-only logout ("sign out everywhere") ends them. Otherwise they end as they always did (Sign out, expiry, the entitlement re-check).

**Rollback.**

- To stop it without a deployment: clear the Back-channel logout URL in Super Admin. Workeasy360 stops sending logout tokens and stops putting `sid` in ID tokens; Help Desk behaves as before. Nothing changes on this side.
- To roll back the release: clear the URL first. (If it stays registered, the previous release answers `404`, which Workeasy360 records as a final failure without retrying; sessions simply live on as before.) The two tables can stay: the previous release does not read them, and rolling forward again picks up where it left off.

## SSO-only mode

With `WORKEASY360_SSO_ONLY` on, the API answers `403 PASSWORD_SIGN_IN_DISABLED` for agent `login`, `register`, `forgot-password`, `reset-password`, `change-password`, setting a password when creating a user, and `POST /users/:id/invite`; `GET /auth/register` reports `enabled: false`; and `GET /auth/methods` reports `{ password: false, workeasy360: true, workeasy360SignOut }`. The login page then shows only **Continue with Workeasy360** (no form, no register or forgot-password links, **never an automatic redirect**: the page itself starts nothing, whatever its query) and a message for each `sso_error` code. Opening any other agent page with no session at all starts the sign-in for the person ("Opening Easy Help Desk directly" above), except after a sign-out or within 60 seconds of the last automatic start. Customer portal sign-in, sign-up and password reset are unaffected.

**Sessions that predate SSO-only.** Every refresh token records how its session was started (`PASSWORD` or `WORKEASY360`). In SSO-only mode an agent session in an organization bound to Workeasy360 whose user has no Workeasy360 identity is refused on every non-public route with `403 WORKEASY360_SIGN_IN_REQUIRED`, and `POST /auth/refresh` refuses password-method families and unlinked accounts with the same code (the frontend sends the person to the sign-in page with an explanation; once an operator has linked the account with `link-workeasy360-user`, which ends what the password issued, signing in with Workeasy360 opens a normal session). API keys stay at the organization level, development (SSO-only off) keeps today's behaviour, and customers' help center sessions are not affected. `link-workeasy360-organization` revokes the organization's existing agent refresh tokens when it binds it.

**How SSO-only retires agent passwords.** Linking leaves an agent's password hash, and any reset or invitation link already mailed, where they are. SSO-only mode is what retires them: agent `login`, `reset-password`, `change-password`, `register` and invitations are refused (`403 PASSWORD_SIGN_IN_DISABLED`), and every password-started session is refused at refresh, so a stored password opens nothing while the switch is on. Turning SSO-only off again brings the passwords back, which is the rollback. Deleting the hashes for good is a separate, later step, once the migration and linking have been tested; nothing in this release does it.

**Rollout for an organization that already has agents:** bind it (`link-workeasy360-organization`), link each existing agent (`link-workeasy360-user`), then turn SSO-only on. Agents not linked yet are refused with `account_conflict` and see "contact your administrator to have it linked".

**Customers keep passwords.** The help center has its own reset route, `POST /api/v1/portal/<slug>/auth/reset-password`, which accepts only a password-reset token of a customer of that help center (an agent's token, an invitation token or another help center's token look like an invalid link and are not consumed); the agent route stays off. The help center's forgot-password mails customers only.

Agent routes also now require an agent token: a help center customer's token (same shape, own cookie) is refused with `403 FORBIDDEN` on every agent route, including those that ask for no permission such as `GET /auth/me`.

## Local development

`NODE_ENV=development` leaves SSO-only off, so password sign-in keeps working with no Workeasy360 running and `GET /auth/methods` reports `workeasy360: false`. To rehearse the real flow, register a development integration whose redirect URI is `http://localhost:4000/api/auth/callback/workeasy360` (Workeasy360 accepts `http://localhost` outside production), fill in `backend/.env`, and set `WORKEASY360_SSO_ONLY=false` (both ways in) or `true`. The frontend's `NEXT_PUBLIC_API_URL` origin is where Continue with Workeasy360 points, so in development the callback lands on the API's port and then redirects to `FRONTEND_URL`.

## Limits

- The check on a signed-in request is per person, once per window, so the worst case after access ends is one window (15 minutes), not the life of the session.
- Realtime (Socket.IO): the `/rt` channel is for agents only (a customer's token is refused). A socket is checked at connect and again every `REALTIME_ACCESS_RECHECK_SECONDS` (default 60) through the same cached decision HTTP requests use, so a person whose access ended (or who must sign in with Workeasy360) receives `access.ended` and is disconnected within one re-check, even though `POST /auth/refresh` stays public and keeps minting tokens for them (the access-ended screen needs it). An outage of Workeasy360 never disconnects anyone.
- A denied organization's overdue SLA tickets are left out of the scan's queries until its denial is due to be asked again (15 minutes; a minute for a refusal), and the skip is logged when it begins or changes, not on every sweep.
- Inbound provider webhooks that create tickets without an agent (`/api/v1/webhooks/...`) are not refused for an organization whose access ended; the help center's own routes (including the chat widget) are. What it triggers (automations, replies, notifications, webhooks, AI, SLA) is gated in the worker.
- Back-channel logout (and Sign out) ends the session and its access tokens at once: there is no access-token grace period. The price is one PostgreSQL query per authenticated request ("Ending a session ends its access tokens"); while the database cannot answer, authenticated requests get `503 SERVICE_UNAVAILABLE`.
- A realtime socket whose session ended without an announcement (Redis unavailable at that moment; a password change, a deactivated user or the link script, which do not announce) stays connected until its next re-check, at most `REALTIME_ACCESS_RECHECK_SECONDS` (60 s by default). It can only receive events in that time: a request it triggers is refused.
- A refresh already in flight at the very moment a Sign out (or a password change) revokes a password-started session can still store its successor token, which then keeps that session alive; this race predates this release and needs both requests within milliseconds. Sessions opened by Workeasy360 are not exposed to it after a back-channel logout, because the ended sign-in refuses the family whatever its tokens say.
- A logout token that arrives while the callback for that very Workeasy360 sign-in is running: after the callback recorded the sign-in, the new session is refused at once, for requests and for its first refresh; before the record (between the code exchange and the record, milliseconds), the token finds nothing to end and the new session lives on. Ended `sid`s are not remembered to refuse such a sign-in.
- Redis 6.2 or newer is required (`GETDEL`).
- Entitlement answers and sign-in flows need Redis; without it sign-in fails closed (`unavailable`).
- **No issuer-move command.** Links are on (issuer, `sub`) and a sign-in no longer re-links by address, so if `WORKEASY360_ISSUER` changes (for example `auth.` to `accounts.`) every existing agent is refused with `account_conflict` until relinked. `link-workeasy360-user` accepts the same `sub` under the new issuer (and refuses a different one), one account at a time; a bulk move is not written yet. Set the final issuer before the first sign-ins, or relink in the same release.
