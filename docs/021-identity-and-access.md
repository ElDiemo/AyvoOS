# 021 — Identity and access (Milestone 2C)

Status: **Implemented on branch `feat/identity-access-core` — DEV activation pending the owner's
WorkOS setup** (section 9). Decision: [ADR 0022](adr/0022-external-oidc-authentication.md);
roles and permissions follow [doc 020 §12](020-production-core-v0.1.md) and this document; custom
roles [ADR 0024](adr/0024-custom-roles-and-permission-catalogue.md); sites and site scopes
[doc 022](022-multi-site-foundation.md) / [ADR 0023](adr/0023-sites-as-operational-boundary.md).

## 1. What this milestone delivers

- Sign-in through an external OIDC identity provider — **WorkOS AuthKit** behind a provider
  boundary (`apps/api/src/identity`); the code is exchanged server-to-server and the access token
  is verified strictly (section 5a) before anything is trusted.
- AYVO users, their link to the external identity, system and custom roles, permissions, site and
  warehouse scopes, the session's active site, AYVO application sessions and a security audit — all in PostgreSQL, evaluated by the API on **every
  request**.
- A global NestJS guard: **deny by default**; every route declares `@Public()`,
  `@Authenticated()` or `@RequirePermission(…)`; an undeclared route is refused (and a test fails).
- Next.js: every internal page requires a signed-in, active user; navigation and pages follow the
  permissions; the API stays the security boundary (a hidden button is never the protection).
- Czech pages: sign-in, "Nemáte oprávnění", "Účet není aktivní" / "Účet nemá přístup", "Relace
  vypršela"; user and role administration with reasons and audit; sign-out.
- One-time, audited bootstrap of the first administrator.
- Redis-backed rate limiting of the sign-in routes (section 5b).
- Administration of custom roles (checkboxes) and sites (doc 022).
- No authentication bypass on DEV or production: the fake provider used by automated tests is
  refused by the configuration unless `APP_ENV=test`.

## 2. Security audit of the code before this milestone (2026-10-11)

| Finding                                                                      | Resolution                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No application authentication; only Caddy Basic Auth on DEV (ADR 0013, 0017) | OIDC sign-in + AYVO sessions; Basic Auth remains only the outer DEV gate                     |
| 58 admin/warehouse/production routes callable by anyone past Basic Auth      | Global deny-by-default guard; every route has an explicit permission (matrix below)          |
| Next.js server components called the API without any user context            | Only the AYVO session cookie is forwarded; 401/403 lead to the sign-in / status pages        |
| `actor_id` columns empty                                                     | Audit actors exist now; filling operational `actor_id`s comes with Production Core (doc 020) |
| State-changing requests without CSRF protection                              | SameSite=Lax HttpOnly cookie + Origin / Sec-Fetch-Site check on every non-GET request        |
| Deploy verification expected `GET / → 200`                                   | Now: `GET /` → sign-in redirect, `/login` 200, `/api/auth/me` 401 without a session          |

## 3. Data model (additive migrations)

Migrations: `20261011190000_identity_access`, `20261012090000_identity_permission_refinements`,
`20261012120000_site_scope_type`, `20261012120100_sites_and_custom_roles`,
`20261012150000_site_owned_production_and_costs`, `20261012180000_user_invitations`.

| Table                      | Purpose and database rules                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                    | AYVO user: e-mail (lower-case, unique, immutable), display name, `ACTIVE`/`DEACTIVATED` (fields consistent by CHECK), last login; never deleted                                            |
| `user_identities`          | external identity link (provider `WORKOS`/`TEST`, subject); one active link per subject and per (user, provider); closes once; never deleted                                               |
| `roles`                    | 8 protected **system** roles (seeded) and ADMIN-created **custom** roles: stable `id`, unique code, Czech name, description, active, `is_system`, timestamps; never deleted (section 7a)   |
| `permissions`              | catalogue (18 permissions) incl. `warehouse_scoped` and `security_admin`; inserted/changed **only inside a migration** (database guard)                                                    |
| `role_permissions`         | system roles: only by migration; custom roles: by ADMIN (audited); a custom role never holds a security-administration permission (trigger)                                                |
| `user_roles`               | grants with grantor and reason; revocation closes once with revoker and reason; one open grant per (user, role); an inactive role cannot be granted; never deleted                         |
| `user_scopes`              | `SITE` (a site) and `WAREHOUSE` (narrows an accessible site — needs the open site scope, trigger); `HOTEL_ORGANIZATION` / `HOTEL_SITE` reserved; closes once; never deleted                |
| `user_sessions`            | AYVO sessions: only the SHA-256 of the 256-bit cookie token, idle and absolute expiry, the **active site**, revocation once (reason); only activity, active site and revocation may change |
| `auth_login_states`        | one-time OAuth state (hash), browser binding (hash), PKCE verifier, safe next path, 10-minute expiry                                                                                       |
| `identity_bootstrap`       | the single bootstrap of the first administrator — one row ever (primary key `true`), immutable                                                                                             |
| `audit_events`             | append-only security/administration audit with actor, target, **site**, reason, time (UPDATE/DELETE/TRUNCATE rejected)                                                                     |
| `sites`                    | AYVO facilities (doc 022)                                                                                                                                                                  |
| `user_invitations`         | invitations of prepared users (state, provider invitation id, expiry, accepted subject); one open per e-mail and per user; forward-only states; never deleted (section 7b)                 |
| `user_invitation_requests` | idempotency and attempt lease of every send/resend/revoke request; completes once; never deleted                                                                                           |

The refinements migration INSERTs permissions and grants only (role descriptions: text). The sites
migration adds columns with defaults (existing rows of immutable tables are never updated), one
initial site `CZ-PREROV-01`, the catalogue guard and the site scopes of users who had warehouse scopes
(doc 022 §5, with the preservation evidence). Existing data is untouched; no user is invented. After
migration nobody can sign in until the administrator is bootstrapped (section 8).

## 4. Roles and permissions (system roles)

| Permission                     |   Where    | ADMIN | WH_OP | WH_SUP | PROD_OP | PROD_SUP | SALES | FINANCE | HOTEL |
| ------------------------------ | :--------: | :---: | :---: | :----: | :-----: | :------: | :---: | :-----: | :---: |
| `identity:users_read` ⚿        |   global   |   ✓   |       |        |         |          |       |         |       |
| `identity:users_manage` ⚿      |   global   |   ✓   |       |        |         |          |       |         |       |
| `identity:roles_manage` ⚿      |   global   |   ✓   |       |        |         |          |       |         |       |
| `sites:manage` ⚿               |   global   |   ✓   |       |        |         |          |       |         |       |
| `sites:all_access` ⚿           |   global   |   ✓   |       |        |         |          |       |         |       |
| `inventory:read`               | site + wh. |   ✓   |   ✓   |   ✓    |    ✓    |    ✓     |       |    ✓    |       |
| `inventory:stock_summary`      | site + wh. |   ✓   |       |        |         |          |   ✓   |         |       |
| `inventory:receive`            | site + wh. |   ✓   |   ✓   |   ✓    |         |          |       |         |       |
| `inventory:correct`            | site + wh. |   ✓   |       |   ✓    |         |          |       |         |       |
| `inventory:items_manage`       | site + wh. |   ✓   |       |   ✓    |         |          |       |         |       |
| `procurement:suppliers_manage` | site + wh. |   ✓   |       |   ✓    |         |          |       |         |       |
| `procurement:cost_read`        |    site    |   ✓   |       |        |         |          |       |    ✓    |       |
| `procurement:cost_write`       |    site    |   ✓   |       |        |         |          |       |    ✓    |       |
| `procurement:documents_read`   |    site    |   ✓   |       |   ✓    |         |          |       |    ✓    |       |
| `production:read`              |  site (P)  |   ✓   |       |        |    ✓    |    ✓     |       |         |       |
| `production:bottles_create`    |  site (P)  |   ✓   |       |        |         |    ✓     |       |         |       |
| `production:labels_print`      |  site (P)  |   ✓   |       |        |    ✓    |    ✓     |       |         |       |
| `production:label_apply`       | site + wh. |   ✓   |       |        |         |    ✓     |       |         |       |
| `production:templates_manage`  |   global   |   ✓   |       |        |         |          |       |         |       |

⚿ security administration — only the ADMIN system role may hold it (database-enforced).
**Where** — _site + wh._: the session's active site must be accessible (site scope, or global
access), run a warehouse (`WAREHOUSE` capability) and have a warehouse the user may act on;
_site_: the active site must be accessible and the data is filtered by it; _(P)_: the site must
have the `PRODUCTION` capability; _global_: not bound to a site. Writes at an inactive site are
refused. A user may hold several roles (system and custom); the permissions add up.

- **ADMIN sees and manages the whole system** — through ordinary `role_permissions` rows, never a
  code bypass; its global site access is the explicit permission `sites:all_access`, evaluated by
  the authorization service (it switches the active site like anyone). The guard, scope
  evaluation and the last-administrator protection apply to ADMIN like to anyone. **Every
  permission a future migration adds must be reviewed and granted to ADMIN explicitly** (and is not
  given to any custom role); `test/identity.e2e.test.ts` compares the database with this table and
  fails otherwise.
- **Purchasing belongs to the receiving site.** Supplier master data is company-wide; supplier
  documents, receipts, prices and purchasing history belong to the site that received the goods
  and are read and changed only at that (active, authorized) site — another site's document,
  receipt or price is "not found", also by id/code and through idempotent replays.
- **Purchase prices** (`unitPrice`, `currency`, `vatRate`, `costUpdatedAt`) need
  `procurement:cost_read`; **supplier documents** need `procurement:documents_read`. Without them
  the API **omits** the fields from every receipt response (detail, create, link document,
  correction, price completion, idempotent replays) — filtered on the server
  (`receiptForViewer`), never only hidden in the UI. Receipt lists carry no prices.
- **Recording prices needs `procurement:cost_write`** (ADMIN, FINANCE). Warehouse staff record
  quantities, lots and the delivery documents; a receipt request with any price, currency or VAT
  value from a caller without `cost_write` is **refused** (`403 COST_WRITE_REQUIRED`) — on create,
  retry and replay; a hidden form field authorizes nothing. FINANCE completes or corrects a line's
  price later (`POST /goods-receipts/:code/lines/:lineNo/cost`): append-only
  (`goods_receipt_line_costs`, the receipt line keeps what was received), reason required, audited
  (`RECEIPT_COST_CORRECTED`, actor, reason, site, old and new values). Prices recorded with a
  receipt are audited too (`RECEIPT_COSTS_RECORDED`). A custom role may combine receiving with
  cost read/write — a deliberate ADMIN decision.
- **Production belongs to the producing site.** Creation series, bottles, print jobs (open,
  generate, PDF), the bottle's physical facts and label applications are listed, opened, printed
  and changed only at their site; a bottle is labelled only at its own site
  (`422 BOTTLE_OF_ANOTHER_SITE`, database trigger too); there is no implicit transfer. **Label
  templates and artwork are company-wide brand data**: every production user reads them;
  changing them needs `production:templates_manage`, which only ADMIN holds by default (a custom
  role may grant it deliberately — the e2e operator gets one).
- **SALES** reads `GET /api/admin/inventory/stock-summary` of its active site only: item (code,
  name, unit), available, reserved, low stock — no lots, suppliers, prices, documents, receipts,
  corrections, movements or write actions.
- **FINANCE** reads stock and receipts (`inventory:read`) with prices and documents of its sites
  and records/corrects prices there; no stock operation.
- `HOTEL_USER` has no permission in the internal application (the hotel portal is separate).
- The standalone label application is supervisor-only until the production scan replaces it
  (doc 020). The Production Core permissions of doc 020 §12 are added by their own migrations.

## 5. Sign-in, session and sign-out

1. `GET /api/auth/login?next=…` creates a one-time state (stored as hash, 10 minutes), a PKCE
   verifier and a browser-binding cookie, then redirects to WorkOS AuthKit.
2. WorkOS signs the person in (passwords, MFA/passkeys, magic links, later SSO are WorkOS'
   concern) and redirects to `GET /api/auth/callback`.
3. The callback consumes the state only together with the matching binding cookie, exchanges the
   code server-side (API key) and verifies the access token. The external subject must be linked
   to an AYVO user. A new identity is linked (once, transactionally, under the user's row lock)
   only to an **ACTIVE prepared user with the same provider-verified e-mail whose AYVO invitation
   the provider reports as accepted by exactly this identity** (section 7b) — or, without an
   invitation, to the bootstrap administrator. Nobody is created automatically. Unknown,
   uninvited, revoked, expired or mismatching identities get the same "Účet nemá přístup";
   deactivated → "Účet není aktivní"; both audited (`LOGIN_DENIED`, with the internal reason).
4. Success creates an AYVO session: 256 random bits in the `ayvo_session` cookie
   (`HttpOnly; Secure; SameSite=Lax; Path=/`), only its SHA-256 in the database; redirect to the
   safe `next` path (same-site paths only).
5. Every request: session lookup → expiry (idle `SESSION_IDLE_MINUTES`, default 120; absolute
   `SESSION_ABSOLUTE_HOURS`, default 12) → user status → roles, permissions and scopes **from the
   database**. A role change applies to the next request; a deactivation revokes all sessions in
   the same transaction.
6. `POST /api/auth/logout` revokes the session, clears the cookie and returns the WorkOS logout URL
   (ends the provider session) or `/login?signed_out=1`.
7. The session's **active site** (doc 022 §4) is chosen with `POST /api/auth/active-site`, stored
   on the session and re-validated against the user's sites on every request.

### 5a. Access-token verification (WorkOS)

The callback accepts only a **human AuthKit user session of this application**. Verification
fails closed; any missing or malformed claim refuses the sign-in (`IdentityVerificationError`,
no token or secret in the message):

- signature against the client-specific JWKS (`/sso/jwks/<WORKOS_CLIENT_ID>`), algorithm **RS256
  only** (no `none`, no HMAC);
- `iss` **exactly** `WORKOS_JWT_ISSUER` — configured, never read from the token; the API refuses
  to start without it (development and production alike);
- `client_id` exactly `WORKOS_CLIENT_ID`;
- `aud`, when present (string or list), only `WORKOS_CLIENT_ID`; AuthKit session tokens carry no
  `aud` by default;
- `sub` a WorkOS user id (`user_…`) equal to the user returned by the code exchange;
- `sid` a non-empty string (machine-to-machine tokens have none);
- `iat` and `exp` integers, `iat < exp`, not expired, `iat` not in the future (30 s clock
  tolerance);
- refused profiles: impersonation/delegation (`act`, `may_act`), agent (`agent`, `agent_id`) and
  machine (`gty`, a non-`authorization_code` `grant_type`, a client id as subject) tokens.

Identity is taken **only** from the session cookie — never from headers such as `X-User-Id`,
`Authorization` or forwarded user headers (tested).

### 5b. Rate limiting of the sign-in routes

- Store: **Redis** (`ayvo:rl:auth:<bucket>:<client IP>`), fixed window — shared by every API
  instance; no in-memory limiter. Counters only (ADR 0010).
- Buckets per client IP within `AUTH_RATE_LIMIT_WINDOW_SECONDS` (default 600):
  `GET /api/auth/login` ≤ `AUTH_RATE_LIMIT_LOGIN_MAX` (30); `GET /api/auth/callback` ≤
  `AUTH_RATE_LIMIT_CALLBACK_MAX` (30); failed callbacks ≤ `AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX`
  (10) — once reached, further callbacks from that IP wait for the window.
- The limit is checked **before** the one-time state is touched; state, binding and PKCE checks are
  unchanged (a blocked valid callback keeps its state usable after the window).
- Exceeded: **`429`** with `Retry-After`; browsers get a short Czech page ("Příliš mnoho pokusů o
  přihlášení"), API clients `{"code":"RATE_LIMITED"}` — no limits, counters or client details.
- Client IP: the socket address, or — only when the socket peer is in `TRUSTED_PROXY_CIDRS` — the
  right-most `X-Forwarded-For` address that is not a trusted proxy. Caddy replaces
  `X-Forwarded-For` with the real client, so a client cannot choose its address. DEV compose:
  `TRUSTED_PROXY_CIDRS=172.16.0.0/12,192.168.0.0/16` (Docker networks; the API publishes no port).
- If Redis cannot give a reliable answer (down, timeout), **new sign-ins are refused** with `503`
  (`AUTH_UNAVAILABLE`; a short Czech page for browsers, `Retry-After`) — rate limiting is never
  silently switched off. Established AYVO sessions live in PostgreSQL and keep working. The
  failure is logged with the bucket and error class only (no address, credential or token). The
  Redis client fails fast (no offline queue, 2-second connect/command timeouts).
- Public passport (`/q/<token>`, `/api/public/*`) rate limiting remains a production blocker
  (doc 016 item 7).

## 6. Route matrix (generated from the code)

Every route not listed as public answers `401 UNAUTHENTICATED` without a session (tested for all
routes). `403 FORBIDDEN` without the permission or warehouse access, `403 SITE_REQUIRED` without an
active site, `409 SITE_INACTIVE` for a write at an inactive site, `409 SITE_WITHOUT_WAREHOUSE`,
`403 ACCOUNT_INACTIVE` for a deactivated user, `401 SESSION_EXPIRED` after expiry,
`403 CSRF_REJECTED` for a cross-site state-changing request, `429 RATE_LIMITED` on sign-in routes.

| Method | Route                                                    | Access                                      | Where                       |
| ------ | -------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| GET    | `/api/auth/callback`                                     | **public**                                  | —                           |
| GET    | `/api/auth/login`                                        | **public**                                  | —                           |
| GET    | `/api/auth/test-provider/authorize`                      | **public**                                  | —                           |
| GET    | `/api/health`                                            | **public**                                  | —                           |
| GET    | `/api/public/bottles/:token`                             | **public**                                  | —                           |
| POST   | `/api/auth/active-site`                                  | signed-in                                   | —                           |
| POST   | `/api/auth/logout`                                       | signed-in                                   | —                           |
| GET    | `/api/auth/me`                                           | signed-in                                   | —                           |
| GET    | `/api/admin/bottle-batches`                              | `production:read`                           | active site                 |
| GET    | `/api/admin/bottle-batches/:code`                        | `production:read`                           | active site                 |
| GET    | `/api/admin/bottle-batches/:code/print-jobs`             | `production:read`                           | active site                 |
| POST   | `/api/admin/bottle-batches/:code/print-jobs`             | `production:bottles_create`                 | active site                 |
| GET    | `/api/admin/bottle-creation-history`                     | `production:read`                           | active site                 |
| POST   | `/api/admin/bottle-registrations`                        | `production:bottles_create`                 | active site                 |
| GET    | `/api/admin/bottles`                                     | `production:read`                           | active site                 |
| GET    | `/api/admin/bottles/:code`                               | `production:read`                           | active site                 |
| GET    | `/api/admin/bottles/:code/physical`                      | `production:read`                           | active site                 |
| GET    | `/api/admin/goods-receipts`                              | `inventory:read`                            | active site + its warehouse |
| POST   | `/api/admin/goods-receipts`                              | `inventory:receive`                         | active site + its warehouse |
| GET    | `/api/admin/goods-receipts/:code`                        | `inventory:read`                            | active site + its warehouse |
| POST   | `/api/admin/goods-receipts/:code/corrections`            | `inventory:correct`                         | active site + its warehouse |
| POST   | `/api/admin/goods-receipts/:code/documents`              | `inventory:receive`                         | active site + its warehouse |
| POST   | `/api/admin/goods-receipts/:code/lines/:lineNo/cost`     | `inventory:read` + `procurement:cost_write` | active site + its warehouse |
| GET    | `/api/admin/identity/permissions`                        | `identity:users_read`                       | global                      |
| GET    | `/api/admin/identity/roles`                              | `identity:users_read`                       | global                      |
| POST   | `/api/admin/identity/roles`                              | `identity:roles_manage`                     | global                      |
| GET    | `/api/admin/identity/roles/:id`                          | `identity:users_read`                       | global                      |
| POST   | `/api/admin/identity/roles/:id`                          | `identity:roles_manage`                     | global                      |
| POST   | `/api/admin/identity/roles/:id/deactivate`               | `identity:roles_manage`                     | global                      |
| POST   | `/api/admin/identity/roles/:id/reactivate`               | `identity:roles_manage`                     | global                      |
| GET    | `/api/admin/identity/sites`                              | `identity:users_read`                       | global                      |
| GET    | `/api/admin/identity/users`                              | `identity:users_read`                       | global                      |
| POST   | `/api/admin/identity/users`                              | `identity:users_manage`                     | global                      |
| GET    | `/api/admin/identity/users/:id`                          | `identity:users_read`                       | global                      |
| POST   | `/api/admin/identity/users/:id/deactivate`               | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/invitations`              | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/invitations/resend`       | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/invitations/revoke`       | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/reactivate`               | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/roles/grant`              | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/roles/revoke`             | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/sites/grant`              | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/sites/revoke`             | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/warehouses/grant`         | `identity:users_manage`                     | global                      |
| POST   | `/api/admin/identity/users/:id/warehouses/revoke`        | `identity:users_manage`                     | global                      |
| GET    | `/api/admin/identity/warehouses`                         | `identity:users_read`                       | global                      |
| GET    | `/api/admin/inventory/items`                             | `inventory:read`                            | active site + its warehouse |
| POST   | `/api/admin/inventory/items/:code/settings`              | `inventory:items_manage`                    | active site + its warehouse |
| GET    | `/api/admin/inventory/lots`                              | `inventory:read`                            | active site + its warehouse |
| GET    | `/api/admin/inventory/movements`                         | `inventory:read`                            | active site + its warehouse |
| GET    | `/api/admin/inventory/stock`                             | `inventory:read`                            | active site + its warehouse |
| GET    | `/api/admin/inventory/stock-summary`                     | `inventory:stock_summary`                   | active site + its warehouse |
| GET    | `/api/admin/label-applications`                          | `production:read`                           | active site                 |
| POST   | `/api/admin/label-applications`                          | `production:label_apply`                    | active site + its warehouse |
| POST   | `/api/admin/label-artworks`                              | `production:templates_manage`               | global                      |
| GET    | `/api/admin/label-artworks/:id/content`                  | `production:read`                           | active site                 |
| GET    | `/api/admin/label-calibration/qr-validation-sheet.pdf`   | `production:read`                           | active site                 |
| GET    | `/api/admin/label-designer/settings`                     | `production:read`                           | active site                 |
| GET    | `/api/admin/label-print-jobs/:code`                      | `production:read`                           | active site                 |
| POST   | `/api/admin/label-print-jobs/:code/generate`             | `production:labels_print`                   | active site                 |
| GET    | `/api/admin/label-print-jobs/:code/pdf`                  | `production:read`                           | active site                 |
| GET    | `/api/admin/label-template-versions/:id`                 | `production:read`                           | active site                 |
| GET    | `/api/admin/label-template-versions/:id/calibration.pdf` | `production:read`                           | active site                 |
| GET    | `/api/admin/label-templates`                             | `production:read`                           | active site                 |
| POST   | `/api/admin/label-templates`                             | `production:templates_manage`               | global                      |
| GET    | `/api/admin/label-templates/:id`                         | `production:read`                           | active site                 |
| POST   | `/api/admin/label-templates/:id/archive`                 | `production:templates_manage`               | global                      |
| POST   | `/api/admin/label-templates/:id/restore`                 | `production:templates_manage`               | global                      |
| POST   | `/api/admin/label-templates/:id/versions`                | `production:templates_manage`               | global                      |
| GET    | `/api/admin/sites`                                       | `sites:manage`                              | global                      |
| POST   | `/api/admin/sites`                                       | `sites:manage`                              | global                      |
| GET    | `/api/admin/sites/:id`                                   | `sites:manage`                              | global                      |
| POST   | `/api/admin/sites/:id`                                   | `sites:manage`                              | global                      |
| POST   | `/api/admin/sites/:id/deactivate`                        | `sites:manage`                              | global                      |
| POST   | `/api/admin/sites/:id/reactivate`                        | `sites:manage`                              | global                      |
| POST   | `/api/admin/supplier-documents`                          | `inventory:receive`                         | active site + its warehouse |
| GET    | `/api/admin/supplier-documents/:id/content`              | `procurement:documents_read`                | active site                 |
| GET    | `/api/admin/suppliers`                                   | `inventory:read`                            | active site + its warehouse |
| POST   | `/api/admin/suppliers`                                   | `procurement:suppliers_manage`              | active site + its warehouse |
| POST   | `/api/admin/suppliers/:id/archive`                       | `procurement:suppliers_manage`              | active site + its warehouse |
| GET    | `/api/admin/suppliers/:id/documents`                     | `procurement:documents_read`                | active site                 |

Every receipt response (`GET /goods-receipts/:code`, `POST /goods-receipts`, `…/documents`,
`…/corrections`) omits prices without `procurement:cost_read` and linked documents without
`procurement:documents_read`. Every _active site_ route reads and changes only the active site's
records (another site's series, bottle, print job, receipt, document or price is "not found").
Supplier master data and label templates/artwork are company-wide; everything else belongs to a
site. Prices are recorded only with `procurement:cost_write`.

Web pages: `/login`, `/forbidden`, `/account-inactive`, `/session-expired` and the bottle passport
`/q/<token>` are public; every page under the application shell requires a signed-in user;
`/select-site` chooses the active site; `/warehouse/availability` needs `inventory:stock_summary`,
every other `/warehouse/*` page `inventory:read` (`/warehouse/receipts/new` also
`inventory:receive`); `/production/*`, `/bottles/*`, `/batches/*`, `/label-templates/*` need
`production:read`; `/admin/users` and `/admin/roles` need `identity:users_read` (new user
`identity:users_manage`, new role `identity:roles_manage`), `/admin/sites` needs `sites:manage`.
Navigation tabs follow the same permissions; the API is the boundary.

## 7. Administration (`/admin/users`, ADMIN)

Create pre-provisioned users and assign 1. **roles** (system and active custom roles), 2. **sites**, 3. optionally **narrower warehouses** of those sites; the page shows the server-computed
**effective access** (what the user may do, at which sites and warehouses). Grant/revoke roles,
sites (revoking a site also revokes its warehouses) and warehouses; deactivate/reactivate. Every
change requires a reason, is audited (`USER_CREATED`, `ROLE_GRANTED`, `ROLE_REVOKED`,
`SCOPE_GRANTED`, `SCOPE_REVOKED` with the site, `USER_DEACTIVATED`, `USER_REACTIVATED`) and applies
on the user's next request. The last active administrator can neither lose `ADMIN` nor be
deactivated; nobody can deactivate themselves. No actor can grant a role with a permission it does
not hold (`403 PRIVILEGE_ESCALATION`).

### 7a. Custom roles (`/admin/roles`, ADR 0024)

- **System roles** (the 8 of section 4) are protected templates: not renamed, edited, deactivated
  or deleted in the application (`409 SYSTEM_ROLE_IMMUTABLE`; the database refuses it too); they
  change only by reviewed migrations. They can be **duplicated** into a custom role.
- **Custom roles** (`identity:roles_manage`, ADMIN only): code (`^[A-Z][A-Z0-9_]{2,39}$`, unique,
  immutable), Czech name, description, permissions chosen by **checkboxes grouped by module**,
  active/inactive, timestamps, history (`ROLE_CREATED` incl. the duplicated source,
  `ROLE_UPDATED` with added/removed permissions, `ROLE_DEACTIVATED`, `ROLE_REACTIVATED`).
- Refused: unknown or obsolete permission codes (validation and foreign key); security
  administration permissions (`422 SECURITY_PERMISSION_RESERVED`, database trigger); permissions
  the actor does not hold; deactivating a role still held (`409 ROLE_IN_USE` — reassign or remove
  first); granting an inactive role (`409 ROLE_INACTIVE`, database trigger).
- A custom role holds exactly its chosen permissions — never one introduced later unless ADMIN adds
  it. Changes apply to all holders on their next request.
- No direct per-user permission overrides: a special combination is a named custom role.

### 7b. Invitations (onboarding from AYVO OS)

1. ADMIN creates the prepared user (name, normalized e-mail) with roles, sites and optional
   warehouses — access is configured **before** anyone is invited.
2. AYVO immediately sends an invitation through the provider's server-side API (WorkOS
   `POST /user_management/invitations`, valid 7 days; the API key never leaves the server).
3. The person follows the invitation e-mail and registers at WorkOS (with MFA).
4. On the first successful sign-in AYVO asks the provider for that invitation and links the
   identity only if it is **accepted by exactly the signing-in user** (`accepted_user_id` = token
   `sub`, same verified e-mail) and the AYVO invitation is still pending; the invitation becomes
   ACCEPTED and the identity is linked in one transaction under the user's lock. Simultaneous
   first sign-ins link once. A provider identity is linked to at most one user (unique index).
5. Unknown, uninvited, revoked, expired or mismatching identities are refused with the same
   answer; a deactivated prepared user is refused although WorkOS signed the person in.

| State (`user_invitations`) | Czech UI              | Meaning                                                                         |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `SENDING`                  | Odesílá se            | recorded; the provider call is running or was interrupted (reconciled on retry) |
| `PENDING`                  | Čeká na přijetí       | sent; valid until `expires_at` (shown as **Vypršela** afterwards)               |
| `ACCEPTED`                 | Přijata               | registered through it and linked at first sign-in                               |
| `EXPIRED`                  | Vypršela              | not accepted in time — resend sends a new invitation                            |
| `REVOKED`                  | Zrušena               | cancelled by ADMIN (at the provider and in AYVO)                                |
| `FAILED`                   | Nepodařilo se odeslat | the provider refused; nothing was sent — resend tries again                     |

Administration (`identity:users_manage`, ADMIN; reason required; audited as `INVITATION_SENT`,
`INVITATION_RESENT`, `INVITATION_REVOKED`, `INVITATION_FAILED`, `INVITATION_ACCEPTED`):
`POST /api/admin/identity/users/:id/invitations` (send), `…/invitations/resend` (sends the pending
invitation again, or a new one after expiry/failure/revocation), `…/invitations/revoke`; the
account is deactivated with the existing action (history stays).

Reliability and safety:

- Every action carries a client `requestId` and is **idempotent** (`user_invitation_requests`);
  a retry continues an interrupted action, the same id for another action is a conflict, and an
  attempt lease stops concurrent retries from calling the provider twice.
- A **lost provider response** (timeout, 5xx) keeps the invitation `SENDING` and answers 503; the
  retry first looks up the provider's pending invitations of the e-mail and adopts one instead of
  sending a second. A definite refusal marks it `FAILED`. No provider failure grants anything:
  only an accepted, matching invitation links an identity.
- One open invitation per normalized e-mail and per user (partial unique indexes); the invitation
  e-mail must equal the user's; states only move forward; nothing is deleted.
- **Truthful outcomes.** After every provider call the invitation is re-read under lock. A revoke
  or resend that loses against a simultaneous acceptance (or a closed invitation) is reported as
  `409 INVITATION_ACCEPTED` / `INVITATION_CLOSED` and audited as `INVITATION_ACTION_SKIPPED`
  (with the real outcome) — never as revoked or resent. A request's outcome is stored, so
  repeating the same request id gives the same answer (also for `FAILED` → `502`).
- An unanswered provider call is audited as `INVITATION_INTERRUPTED` (not as failed or sent);
  a definite refusal as `INVITATION_FAILED`. Both write a structured log line (event, user id,
  action, error class — no e-mail, key, token or link).
- The administration keeps one request id per user attempt and repeats it after a network error
  or `503`/`INVITATION_IN_PROGRESS` until the action ends with success or a definite result.
- If the automatic invitation at user creation fails, the user stays prepared but unable to sign
  in (`FAILED` or `SENDING`); the user page shows a warning and "Poslat pozvánku znovu"; the
  failure is logged and audited, never swallowed.
- A pending provider invitation is adopted only when the e-mail the provider reports for it equals
  the user's normalized e-mail (WorkOS list responses carry `email`).
- Only the provider's invitation id is stored — never its token or acceptance link; errors and
  logs carry no key, token or link.
- The endpoints are ADMIN-only; the sign-in answer never reveals whether an e-mail exists.

## 8. Bootstrap of the first administrator (one-time)

```bash
# inside the API container (DEV), after the migration:
node dist/identity/bootstrap-admin.js --email <owner e-mail verified in WorkOS> --name "<Name>"
```

Creates the ACTIVE user with `ADMIN` (every permission, including the explicit global site access
`sites:all_access` — no scope rows) and audits `ADMIN_BOOTSTRAPPED`. The owner then signs in via
WorkOS with exactly this e-mail, which links the identity. The database permits **one** bootstrap
ever (`identity_bootstrap`); the command refuses afterwards, and there is no endpoint or setting
that bootstraps.

## 9. WorkOS setup the owner must do (nothing of this is in Git)

1. Create a WorkOS account/organization; use the **Staging** environment for DEV.
2. Enable **AuthKit** (User Management). Sign-in methods (e-mail + password, magic link,
   passkeys). **Require MFA for every user** (mandatory for AYVO internal users, doc 012) and
   **allow sign-up only through invitations** (disable public sign-up) — AYVO sends the
   invitations (section 7b); an uninvited WorkOS account is refused by AYVO anyway.
3. Redirect URI (Staging): `https://dev.ayvo.co/api/auth/callback`.
4. Sign-out redirect (allowed logout return URL): `https://dev.ayvo.co/login?signed_out=1`.
5. Copy the **API key** (`sk_test_…`) and the **Client ID** (`client_…`) of the Staging
   environment.
6. Store them only in the server env file `/opt/ayvo/secrets/dev-preview.env` (mode 600), edited
   in your own SSH session — never in chat or Git:
   ```
   WORKOS_API_KEY=sk_test_…
   WORKOS_CLIENT_ID=client_…
   WORKOS_JWT_ISSUER=https://…
   ```
   `WORKOS_JWT_ISSUER` is **required** and compared exactly: copy the issuer shown for the
   environment in the WorkOS dashboard (session/JWT settings; it is your AuthKit domain, or the
   custom auth domain if one is configured), or the `iss` of a decoded access token of that
   environment — including or excluding the trailing slash exactly as WorkOS issues it. A wrong
   value refuses every sign-in (fail closed) without exposing anything.
7. In WorkOS, invite/create **only the owner's** user (the e-mail used for the bootstrap). Every
   later user is invited from AYVO OS (section 7b) — never create them manually in WorkOS.
8. Then the DEV deployment can run (`scripts/deploy-dev.sh` refuses without the three values) and
   the one-time bootstrap (section 8). After the first sign-in, complete the address of the
   initial site `CZ-PREROV-01` in **Správa systému → Provozovny** (doc 022 §5).

**DEV acceptance checklist for invitations (WorkOS Staging, after deployment):**

1. Invite a test colleague from AYVO; WorkOS shows the invitation as pending for exactly that
   e-mail, and AYVO shows "Čeká na přijetí".
2. Accept it, register with MFA and sign in: AYVO links the account ("Přijata").
3. Confirm with a WorkOS `GET /user_management/invitations/{id}` (dashboard or API) that the
   accepted invitation carries a non-empty `accepted_user_id` equal to the signed-in user's id
   (`sub`). If WorkOS did not return it, AYVO refuses the link (fail closed) — report it before
   relying on invitations.
4. Revoke an unused invitation and confirm that signing up with it is refused by WorkOS and AYVO.

Optional server env values (defaults shown; not secrets): `AUTH_RATE_LIMIT_WINDOW_SECONDS=600`,
`AUTH_RATE_LIMIT_LOGIN_MAX=30`, `AUTH_RATE_LIMIT_CALLBACK_MAX=30`,
`AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX=10`; `TRUSTED_PROXY_CIDRS` is set by the Compose file.

Before production: pricing, DPA and EU data-location check of WorkOS (ADR 0022); production
environment values in the production secret store; `APP_PUBLIC_ORIGIN` of production.

## 10. Tests

- API unit: WorkOS adapter (authorization URL with state and PKCE, server-side exchange, refusal
  of foreign-key, HMAC, expired, other-subject, wrong/missing/trailing-slash issuer, wrong/missing
  client id, foreign audience, missing/empty `sid`, missing/malformed/future/inverted `iat`/`exp`,
  machine-to-machine, impersonation, agent and client-credentials tokens — each verified to fail
  for its own reason; the exchanged identity must match the token subject; no secrets in errors);
  configuration (fake provider refused outside tests, WorkOS key, client id and https issuer
  required in development and production, rate-limit and proxy settings validated, secrets never
  echoed); trusted-proxy client IP; site/warehouse scope evaluation; no privilege escalation.
- API integration (real migrated database, real guard and sessions): every route declares access
  and answers 401 anonymously; sign-in, secure cookie, hashed token; unknown identities refused and
  audited; single-use state bound to the browser; safe redirects; permissions, site and warehouse
  scopes; no identity from headers; role change and deactivation effective at once; expiry;
  logout; CSRF; one-time bootstrap; last-admin protection; append-only audit; public passport and
  health; the system role matrix equals section 4 (ADMIN holds every permission), catalogue and
  system roles unchangeable outside migrations; prices and documents omitted for every restricted
  role (detail, list, create, link, idempotent replay; document lists and files refused); SALES gets
  only the summary. **Rate limiting** (real Redis): normal sign-in, 429 page/JSON with
  `Retry-After`, other clients unaffected, recovery after the window, failed callbacks blocking
  before the state is consumed, no dodging through `X-Forwarded-For` from an untrusted peer, fail
  open without Redis. **Custom roles**: create from permissions (with duplicate source), assign,
  immediate gain and loss of access, role in use not deactivatable, inactive role not grantable,
  system roles immutable, security/unknown permissions refused (API and database), non-admins
  refused on every role, user, site and catalogue route. **Sites**: validation, immutable code,
  never deleted, valid time zone, capability rules, deactivation blockers, read-only inactive site.
  **Isolation**: a Czech-site user never reads or corrects a German receipt (code, list,
  movements), forged active-site choice refused and audited, site ids in query/cookie/headers
  ignored, a multi-site user switches and sees only the selected site's stock, losing a site ends
  access at once, a warehouse outside the allowed site refused (API and database), audit events
  carry their site, ADMIN's global access as a permission without scope rows, label applications
  of another site not listed. **Site-owned production and purchasing** (IDOR): another site's
  series, bottles, physical facts, print jobs (open, create, generate, PDF) are 404 and absent from
  every list; a registration replay from another site is a conflict that names nothing; a bottle
  cannot be labelled at another site (API and trigger) or moved (trigger); templates readable
  everywhere, changed only with the global permission; the public passport reveals no site;
  another site's documents, receipts and price endpoints are 404 by id/code; documents cannot be
  linked across sites (API and trigger). **Prices**: refused without `cost_write` on create and
  replay (also hidden fields), FINANCE completes a price append-only with reason, actor and site
  in the audit, staff cannot correct or see it. **Redis outage**: 503 for login and callback,
  never unlimited, signed-in sessions unaffected. **Invitations** (fake provider with failure markers; real
  database): send on creation after roles and sites, sign-in links once and marks ACCEPTED, a lost
  provider response reconciled on retry without a second invitation, idempotent request ids and
  conflicts, provider refusal → FAILED and no sign-in, revocation (idempotent, blocks sign-in,
  resend invites anew), expiry, e-mail normalization and duplicate prevention (API, concurrency
  and database), identity mismatch refused, simultaneous first sign-ins link once, deactivated
  invited user refused, ADMIN-only endpoints, no enumeration; WorkOS adapter: bearer key
  server-side, token and link never kept, refused vs. ambiguous failures, no secrets in errors;
  session defaults 120 min / 12 h. **Last administrator**: also refused by the
  database at commit (single statement or transaction), catalogue TRUNCATE refused.
- Playwright: sign-in redirects back to the requested page; anonymous API 401; unknown identity;
  administration (create, grant, revoke, deactivate with reasons and audit) and its immediate
  effect in a second browser; forbidden and inactive pages; sign-out; ADMIN sees every module;
  prices/documents hidden from a warehouse operator on the page and through direct API calls,
  FINANCE sees both; SALES sees only Sklad → Dostupnost; **ADMIN builds a custom role from
  checkboxes, assigns it with two sites (preview), the user's navigation follows, chooses a site,
  switches sites (other site's data gone), narrowing the role and removing a site take effect at
  once**; a user of the other site cannot see or open this site's series, bottles or print jobs
  (page 404, API 404); FINANCE completes a price in the receipt page, the warehouse operator gets
  no price form; widths 320/390/1280 for administration, role, site and site-selection pages without
  horizontal overflow; no arbitrary sleeps.

## 11. Limitations and follow-ups

- **DEV activation needs the owner's WorkOS values** (section 9); until then the DEV preview stays
  on the previous release (deploy refuses).
- Public passport rate limiting is still open (doc 016 item 7); sign-in routes are limited
  (section 5b) and fail closed (503) without Redis.
- The token rules of section 5a follow WorkOS' published AuthKit session-token claims
  (`iss`, `sub`, `sid`, `client_id`, `iat`, `exp`; no `aud` by default). They are proven against
  locally signed tokens only; the first real DEV sign-in confirms them against WorkOS.
- Operational `actor_id` columns (bottle events, movements) are filled with Production Core.
- Hotel scopes, hotel SSO and the hotel portal come with the hotel modules.
- ADMIN holds every operational permission; the doc 020 §12 rule that operational actions by
  ADMIN need a mandatory reason (emergency override) is not enforced yet — it comes with the
  Production Core actions that carry actors and reasons.
- One active site per session (tabs share it); warehouses are created by migration (doc 022 §9).
- Security review P3 follow-ups (section 12): database-role separation for migrations and the
  application, `__Host-` cookie names, per-network/global sign-in buckets, actor foreign keys,
  and refusing warehouse narrowing that excludes a site's operational warehouse.
- Session lifetimes (120 minutes idle, 12 hours absolute) are configurable defaults.

## 12. Independent security review (2026-10-12)

Reviewer: Fable 5.1, independent of the implementation; scope: the complete diff `19baf97..0e2f0b6`
(code reading, a scratch PostgreSQL database with all migrations, concurrent `psql` sessions).

| ID   | Severity | Finding                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                 |
| ---- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 |    P1    | Last-ADMIN race: concurrent "deactivate A" + "revoke ADMIN from B" could leave no active administrator (only the grant rows were locked; the users join came from a stale snapshot) — reproduced | **Fixed**: lock grants and users (`FOR UPDATE OF r, u`); additionally a deferred database guard (`ayvo_last_admin_guard`) refuses at commit any change that leaves no active ADMIN once bootstrapped. Reproduced again: the waiting transaction sees one admin; a forced revoke is refused by the database |
| P2-1 |    P2    | Open redirect on `/login?next=/\evil.com` for signed-in users (web checked `//` but not `\`)                                                                                                     | **Fixed**: one web `safeNextPath` (printable ASCII, no `//`, no `\`, no `/api/`) used by the login, select-site, auth pages and `currentPath`; unit-tested                                                                                                                                                 |
| P3-1 |    P3    | Non-ASCII `next` made the callback's `Location` header throw (500, orphaned session)                                                                                                             | **Fixed**: API `safeNextPath` accepts printable ASCII only                                                                                                                                                                                                                                                 |
| P3-2 |    P3    | Some idempotency payloads lacked the site (label application, document link, correction)                                                                                                         | **Fixed**: the site is part of those payloads; a replay from another site is a conflict                                                                                                                                                                                                                    |
| P3-3 |    P3    | The catalogue guard is a session setting any database session (e.g. via SQL injection) can switch on; the application connects as the owner                                                      | Follow-up: separate migration and application database roles; check the role in the trigger                                                                                                                                                                                                                |
| P3-4 |    P3    | `roles`, `permissions`, `role_permissions` could be truncated                                                                                                                                    | **Fixed**: TRUNCATE triggers                                                                                                                                                                                                                                                                               |
| P3-5 |    P3    | Cookies are not `__Host-` prefixed (a sibling subdomain could plant `Domain=ayvo.co` cookies)                                                                                                    | Follow-up before `qr.ayvo.co` or any other subdomain goes live                                                                                                                                                                                                                                             |
| P3-6 |    P3    | Migration assumes at most one pre-existing warehouse; `goods_receipt_line_costs.actor_id` / audit actors without foreign keys                                                                    | Documented (doc 022 §5); FKs are a follow-up                                                                                                                                                                                                                                                               |
| P3-7 |    P3    | Per-IP fixed window only (IPv6 /64 rotation; office NAT)                                                                                                                                         | Follow-up: per-network and global buckets, tuning with real traffic                                                                                                                                                                                                                                        |
| P3-8 |    P3    | Narrowing a user to a non-default warehouse leaves no workable warehouse route in v0.1                                                                                                           | Follow-up (usability, not escalation)                                                                                                                                                                                                                                                                      |

Areas confirmed sound by the reviewer: WorkOS token validation, state/PKCE/callback, sessions and
logout, CSRF, trusted-proxy IP, custom-role escalation, cross-site IDOR and stale site state,
warehouse-without-site, field-level price/document filtering, audit append-only, route declarations,
secrets handling.
