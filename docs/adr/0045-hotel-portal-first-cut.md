# ADR 0045: Hotel portal — first cut as its own unit behind explicit contracts

- **Status:** Proposed. Owner priority 2026-11-05 (issue #125, part 2), raised again 2026-11-07
  (review 5814164141). For the owner's approval before any implementation.
  - No table, permission, host, DNS record or edge in this ADR exists yet.
  - Everything here is a proposal, not a production implementation.
  - ADR 0044 is the QR presentations proposal (PR #123).
- **Date:** 2026-11-05, revised 2026-11-07 (on `main` `5650409`)
- **Context (verified in the code):**
  - **No portal exists.** `HOTEL_USER` is a planned, unassignable role with no permissions
    (`packages/types/src/identity.ts`, `isPlannedRole`). The hotel scope types
    `HOTEL_ORGANIZATION`/`HOTEL_SITE` exist, but nothing evaluates them.
  - **Native identity in the core** (ADR 0037, doc 038):
    - e-mail and password (Argon2id), then TOTP, always both;
    - invitations and resets by one-time links, and recovery codes;
    - the routes `auth/native/{password,mfa,activate,forgot-password,reset-password,replace-mfa}`
      are rate limited in Redis (`AuthRateLimitService`) and fail closed without Redis;
    - the session cookie `ayvo_session` is host-only (no `Domain`), `HttpOnly`, `Secure`,
      `SameSite=Lax`, `Path=/` (`identity/cookies.ts`);
    - a state-changing request must come from the app's own origin (`Origin`/`Sec-Fetch-Site`,
      `access.guard.ts`).
  - **Finance** (ADR 0039, its own container and schema) owns customers (payers), billing
    agreements and invoices:
    - each invoice has `invoices.customer_id`, the snapshot, the PDF (`pdf_storage_key`,
      `pdf_sha256`) and an optional cancellation;
    - `invoice_lines.hotel_id` (with code and name) is stored **when the invoice is issued**;
    - the payment state `UNPAID | PARTIALLY_PAID | PAID` is derived from allocations
      (`payments.service.ts:60`);
    - the snapshot names the environment `TEST | LIVE`, and on DEV only `TEST` invoices exist;
    - Finance calls the core (`/api/internal/v1/finance/*`, with its own service token and a
      per-request session), never the other way round;
    - its pool is 4 connections, and on DEV its container has 512 MB and 0.5 CPU.
  - **Required rules:**
    - doc 040 §14: access is granted explicitly per payer and its hotels. One hotel never reveals
      the payer's other invoices, and every list, detail and PDF is checked on the server.
    - doc 021 §4c: a separate external shell. Internal and hotel roles are never combined on one
      account.
    - ADR 0038 (proposed): new units are built apart, with per-request introspection.
  - **Exposure today:**
    - the internal OS is tailnet only (ADR 0026/0033), and its DEV Caddy aborts `/api/internal/*`;
    - the public edges (QR, ID, marketing) are anonymous and stateless.

## Decision

### 1. One new process: `portal-web` (Next.js with its own server side, BFF)

- **A new app `apps/portal`.** Its server side (route handlers and server components) is the only
  thing a hotel user's browser talks to. It:
  - holds the portal session cookie;
  - calls the core and Finance contracts with its own service credentials;
  - streams PDFs.
- **No separate portal API process.** It would own no data, so it would add a hop, a credential
  and a failure domain without isolating anything the BFF does not. A second process would be
  justified only by long-running work of its own, and the first cut has none.
- **No database role and no copy of data.** `portal-web` has no connection to PostgreSQL or Redis.
  It reaches the core and Finance only through their contracts.
- **Authorities:**
  - **core:** identity, the portal account, sessions and MFA, grants, hotels;
  - **Finance:** payers, invoices, payment state, PDFs and the invoice visibility rule (§5);
  - **portal-web:** none — it presents and forwards.

### 2. A portal account is its own audience, enforced in the database

- **`users.audience`** (`STAFF | PORTAL`): NOT NULL, set at creation, never changed (trigger).
  Existing users become `STAFF` through the migration's default.
- **`roles.audience`** likewise: `HOTEL_USER` is `PORTAL`, and every other system role and every
  custom role is `STAFF`.
- **A role is granted only to a user of the same audience.** A `user_roles` insert trigger:
  - first takes `SELECT … FOR UPDATE` on the user's row (the fixed lock: user → role grants);
  - then refuses a role of another audience.
  - Two concurrent grants of a `STAFF` and a `PORTAL` role to one account therefore serialize,
    and one is refused. A plain CHECK cannot see other rows, so it is not used.
- **Invitations:**
  - a portal invitation is refused if the e-mail belongs to any existing `STAFF` user
    (`EMAIL_IS_STAFF`); a staff invitation is refused if it belongs to a `PORTAL` user;
  - the check runs in the inviting transaction with the same user lock, and the unique e-mail
    index decides a concurrent race.
- **Sessions carry the audience** (`user_sessions.audience`, copied from the user):
  - the internal guard accepts only `STAFF` sessions;
  - the portal contract accepts only `PORTAL` sessions;
  - Finance's staff path (`/api/internal/v1/finance/*` introspection) refuses a `PORTAL` session;
  - Finance's portal path refuses a `STAFF` one.
- **Tests:**
  - a portal session on every internal API route and on Finance's staff routes → 401;
  - a staff session on every portal contract route → 401;
  - the role and invitation races above.

### 3. Public authentication endpoints (through `portal-web` only)

The browser sees only the portal host. `portal-web` route handlers call the core's portal auth
contract (`/api/internal/v1/portal/auth/*`, portal service token), never the internal
`/api/auth/*`.

| Portal route (`portal-web`)        | Core contract                       | Rate limit (Redis, fail closed)        |
| ---------------------------------- | ----------------------------------- | -------------------------------------- |
| `POST /auth/activate` (invitation) | activate: password + TOTP enrolment | per IP and per invitation token        |
| `POST /auth/password`              | password step                       | per IP and per e-mail (as staff today) |
| `POST /auth/mfa`                   | TOTP or recovery code               | per IP and per pending login           |
| `POST /auth/forgot-password`       | reset request (no account oracle)   | per IP and per e-mail                  |
| `POST /auth/reset-password`        | reset with token, then TOTP         | per IP and per reset token             |
| `POST /auth/logout`                | end session                         | —                                      |

- **CSRF:**
  - the portal cookie is `SameSite=Strict`;
  - every state-changing route checks that `Origin` (or `Sec-Fetch-Site: same-origin`) is the
    portal origin;
  - forms post only to the same origin;
  - there is no CORS.
- **The core is never exposed.** The reverse proxy forwards only to `portal-web` (§7). The core's
  portal contract is reachable only on the internal network, with the portal token.
- **No account enumeration.** Activation, password, reset and forgot-password answer the same way
  for an unknown and a known account.

### 4. Grants: owned by the core, issued without a Core → Finance call

```
portal_grants        id, user (audience PORTAL), payer_customer_id (Finance customer id, opaque to
                     the core — no FK across units), granted_at/by, reason, revoked_at/by/reason
portal_grant_hotels  grant, hotel (FK hotels), UNIQUE (grant, hotel)
```

- **The issuing flow** (the core never depends on Finance at runtime):
  1. **The control layer** is the internal web's server side, under an AYVO ADMIN's staff session.
     - It reads the payer from **Finance** (`finance:billing_read`): the customer, its state and
       the hotels of its billing agreements.
     - The admin chooses the hotels.
     - It is the authority for nothing; it shows Finance's answer.
  2. **The core writes the grant** (`POST /api/admin/identity/portal-grants`, new permission
     `identity:portal_grants_manage`, ADMIN only). The hotels must exist and the user must be
     `PORTAL`. The payer id is stored as given. The core is the authority on who may see which
     hotels, under which payer id.
  3. **Finance decides at every read** whether that payer id matches an invoice (§5). An unknown,
     archived or wrong payer id matches nothing, so the read fails closed.
- **Revocation (the core):**
  - `revoked_*` is set;
  - it takes effect on the next request, because Finance and `portal-web` introspect per request;
  - when the user has no active grant left, or is deactivated, every portal session of the user is
    ended in the same transaction.
- **Refusals:**
  - a grant for a `STAFF` user, a missing hotel or an empty hotel list → 4xx, nothing written;
  - a revoked grant is never revived; a new grant is a new row.
- **Calls go one way only:**
  - `portal-web → core`, `portal-web → Finance`, `Finance → core`;
  - the internal web → core and → Finance, for staff;
  - never `core → Finance`.

### 5. One visibility predicate for invoices, in Finance

For a portal session, Finance gets the user's active grants from the core on every request. This
is a new route on the existing Finance → core contract, `introspect-portal`, which takes `PORTAL`
sessions only. An invoice `i` is visible exactly when:

```
env_allowed(i)                                   -- TEST only where APP_ENV is development/test
                                                 -- (existing policy); never TEST on production
AND EXISTS grant g OF this user, not revoked:
      g.payer_customer_id = i.customer_id        -- the payer stored on the invoice
  AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id)      -- empty set: not visible
  AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id
                   AND l.hotel_id NOT IN g.hotels)                          -- every line's hotel
```

- **One grant covers the whole invoice.** Hotels of two grants are never combined.
- **History:**
  - the predicate uses only what is stored on the invoice and its lines when issued, never today's
    agreements or a hotel's current payer;
  - a hotel that moved to another payer keeps its old invoices visible only under the old payer's
    grant.
- **The same SQL predicate is in the `WHERE` of:**
  - the list, before ordering and pagination, so counts and pages never reveal other invoices;
  - the detail and the PDF, by id.
  - A false predicate answers **404**, exactly like a missing invoice.
- **What it returns:**
  - the issued snapshot: number, dates, total, currency and the hotels of its lines;
  - the payment state (`payments.service.ts:60`);
  - "stornovaná" for a cancelled invoice.
- **The PDF:**
  - is streamed from Finance's storage after the predicate;
  - its SHA-256 is checked against `pdf_sha256`;
  - is sent with `Cache-Control: private, no-store`, `Content-Disposition: attachment` and
    `nosniff`;
  - is never in a public or shared cache.
- **Tests:**
  - two payers A and B, and a chain with a summary invoice over H1 and H2. A grant on H1 only sees
    none of that invoice.
  - payer change: H1 moves from A to B. Old A invoices stay visible to the A grant, not to B.
  - a foreign invoice's id for detail and PDF → 404, also with a valid session;
  - pagination totals exclude foreign invoices;
  - an invoice with an empty line set (forced by SQL in the test DB) is not visible;
  - a TEST invoice is never shown with `APP_ENV=production`;
  - revocation mid-session.

### 6. Dependency map and credentials

```
browser ──HTTPS── reverse proxy (portal host) ──► portal-web
portal-web ──(PORTAL_CORE_TOKEN)──► core     /api/internal/v1/portal/*        auth, introspection, hotels
portal-web ──(PORTAL_FINANCE_TOKEN)──► Finance /api/internal/v1/portal/invoices* + forwarded portal session
Finance ──(FINANCE_SERVICE_TOKEN, existing)──► core /api/internal/v1/finance/introspect-portal
```

- **Each token is separate.** The receiver stores it only as its SHA-256, like the existing
  Finance token, and accepts it only on its own routes:
  - the portal token is never accepted on `/api/internal/v1/finance/*`;
  - the Finance token is never accepted on the portal routes.
- **Secrets** live in each environment's secret files, never in git or the browser.
- **The forwarded portal session** is the session id from the portal cookie, sent by `portal-web`
  to Finance in a header. Finance never trusts a scope from `portal-web`; it introspects that
  session at the core itself.

### 7. Hosts, cookies and the reverse proxy

- **A separate HTTPS origin.** A different port on the same host does not isolate cookies.
  - **DEV:** `dev-portal.ayvo.co`, tailnet only, like `dev.ayvo.co`.
  - **PROD:** `portal.ayvo.co`, public on its own `portal-edge`. The internal OS stays tailnet
    only.
- **Cookies:**
  - the portal cookie is `__Host-ayvo_portal`: host-only, `Secure`, `Path=/`, `HttpOnly`,
    `SameSite=Strict`;
  - the `__Host-` prefix means no other `*.ayvo.co` host can set or overwrite it;
  - the internal `ayvo_session` is already host-only on `dev.ayvo.co`;
  - recommended separately: rename it to `__Host-ayvo_session`, so no sibling host can toss a
    cookie of the same name at the internal app;
  - the server-side audiences (§2) are a second, independent barrier.
- **DEV path** (the same mechanism as `dev.ayvo.co`, ADR 0026; the DNS needs the owner's approval
  and Codex):
  - a public A record for `dev-portal.ayvo.co` → the server's IPv4, used only for ACME HTTP-01 on
    :80;
  - the private split DNS (CoreDNS) answers `dev-portal.ayvo.co` with the Tailscale IP;
  - a Caddy site bound to the Tailscale IP: `@internal /api/internal*` → abort; everything else →
    `reverse_proxy portal-web:3200`; peers outside the tailnet are aborted;
  - **no** route from that site to `web`, `api` or `finance`.
- **PROD path:**
  - the same Caddy rules, on a separate `portal-edge` whose network reaches only `portal-web`;
  - `portal-web` reaches the core and Finance on an internal network;
  - the edge, the host and the DNS need a separate owner approval and Codex (doc 040 §14.1).

### 8. Budgets, timeouts and fail-closed behaviour

| Item                         | Budget / timeout                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `portal-web` container       | 256 MB, 0.5 CPU, 128 pids (DEV and PROD); read-only root, unprivileged                            |
| `portal-web` → core          | keep-alive pool 8; 3 s per call                                                                   |
| `portal-web` → Finance       | pool 4; 5 s for list/detail, 20 s and 10 MB for a PDF (streamed)                                  |
| Finance → core introspection | 2 s                                                                                               |
| core, portal routes          | at most 8 concurrent portal requests (the rest 503); the core's DB pool is shared (pg default 10) |
| Finance, portal routes       | at most 2 concurrent (its DB pool is 4: staff keeps 2)                                            |

- **Fail closed:**
  - every timeout or error on introspection, grants or the predicate gives no data (401/503),
    never a fallback to a cached or broader answer;
  - Redis down: sign-in and the other rate-limited steps answer 503, as for staff today;
  - **Finance down:** "Faktury nejsou dostupné" (503), while "Moje hotely" keeps working;
  - **core down:** the whole portal is unavailable, because no session can be checked;
  - **portal-web down:** the internal OS and Finance are unaffected.
- **Shared failure domains** (accepted for the first cut, named here):
  - on DEV, the same host, Caddy and DNS containers;
  - the same PostgreSQL server (the core DB and the Finance schema, separate roles);
  - the same Redis (rate limits);
  - on PROD the edge is separate (`portal-edge`), and the host is shared with the OS until ADR
    0038 decides otherwise.

### 9. The first cut (P1) — nothing more

- **In P1:**
  - an invitation by an AYVO ADMIN, with the grant;
  - activation and sign-in with password + TOTP (the existing native flow);
  - "Moje hotely": own hotels and their details, **read only**;
  - "Faktury": own invoices, payment state, PDF;
  - revocation by an AYVO ADMIN.
- **Next steps, not in P1:**
  - the ZIP of a period (doc 040 §14 stays the requirement);
  - contact changes. The earlier field list is the starting point for that step: contact,
    receiving contacts, delivery note.
- **Not in the portal at all for now:** hotel groups, ESG, orders, overdue wording (doc 040 §14.5,
  waits for the owner).
- **Labels:** on DEV the invoices are `TEST` and labelled so. Nothing calls them live invoicing
  (doc 040 §13).

### 10. Order of delivery — small PRs, each reviewed on its own

| #   | PR (draft, after the approval of this ADR) | Scope                                                                                                     | Deploy            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | core: account audience                     | `users/roles/user_sessions.audience`, role and invitation triggers, the audience in the guards; tests §2  | DEV with approval |
| 2   | core: portal grants                        | `portal_grants(+hotels)`, `identity:portal_grants_manage`, the admin API and its UI in Správa systému     | DEV with approval |
| 3   | core: portal contract                      | `/api/internal/v1/portal/{auth/*,session,hotels}`, the portal token, rate limits, concurrency cap         | DEV with approval |
| 4   | Finance: portal invoices                   | `introspect-portal` on the core contract, `/api/internal/v1/portal/invoices*`, the §5 predicate and tests | DEV with approval |
| 5   | `apps/portal` (portal-web)                 | the BFF and pages of P1, the `__Host-` cookie, CSRF, Playwright at 390/1440 px                            | not yet           |
| 6   | DEV host `dev-portal.ayvo.co`              | the compose service, the Caddy site, private DNS — the infrastructure part for Codex                      | owner + Codex     |
| 7   | DEV verification (§11)                     | synthetic payers, the walk, a written result                                                              | —                 |
| 8   | PROD activation                            | `portal-edge`, `portal.ayvo.co`, its own ADR addendum and approval                                        | owner + Codex     |

- PRs 1–4 change nothing for staff beyond the audience check.
- PRs 1–3 and 4 can be reviewed in parallel.
- PR 5 needs 3 and 4. PRs 6–8 follow in order.
- **One joint approval is asked for:** this ADR as a whole. That covers the model of §2 and §4,
  the contracts of §5 and §6, and the hosts and budgets of §7 and §8. Every PR, merge and deploy
  is then approved on its own as usual.

### 11. The shortest functional DEV walk (step 7; synthetic data only)

1. **Setup.** An AYVO ADMIN sets up in the internal OS:
   - synthetic payer A with billing agreements for hotels H1 and H2, and payer B for H3;
   - TEST invoices A1 (H1), A2 (H1 + H2, a summary) and B1 (H3).
2. **Invitations.** The ADMIN invites `portal-a@…` (the owner's test mailbox) with a grant
   {payer A: H1}, and `portal-b@…` with a grant {payer B: H3}.
3. **User A:**
   - opens the link on `https://dev-portal.ayvo.co`, sets a password, enrols TOTP;
   - signs in with password + TOTP;
   - sees "Moje hotely": H1 only;
   - sees "Faktury": A1 only (not A2, because H2 is not granted), with its payment state, and
     downloads its PDF.
4. **User B:**
   - sees H3 and B1 only;
   - A's invoice id in B's PDF URL gives 404.
5. **The ADMIN changes access:**
   - extends A's grant with H2: A2 appears on A's next request;
   - revokes A's grant: A's next request gives 401 and the session is gone. Signing in again
     shows no hotels and no invoices.
6. **Failure checks:**
   - with Finance stopped, A sees the hotels and "Faktury nejsou dostupné";
   - the internal OS keeps working.

## Consequences

- **The core migration:**
  - `users.audience`, `roles.audience` and `user_sessions.audience`, with the role-grant and
    invitation triggers;
  - `portal_grants`/`portal_grant_hotels`;
  - `identity:portal_grants_manage` (ADMIN, catalogue migration);
  - `HOTEL_USER` becomes assignable, only to `PORTAL` users.
- **Code:**
  - new contract routes in the core and in Finance;
  - the new app `apps/portal` and its container;
  - the DEV Caddy site (with approval).
- **Tests:** as in §2, §5 and §8; the walk of §11 on DEV.
- **Open for the owner:**
  - the portal languages (cs/en/de, following the payer's document language?);
  - the DEV and PROD host names (`dev-portal.ayvo.co` and `portal.ayvo.co` proposed);
  - whether a cancelled invoice is shown (proposed: yes, labelled "stornovaná", since the payer
    received it);
  - for the later contact step: a direct change, or a proposal AYVO confirms.
