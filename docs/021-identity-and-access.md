# 021 — Identity and access (Milestone 2C)

Status: **Implemented on branch `feat/identity-access-core` — DEV activation pending the owner's
WorkOS setup** (section 9). Decision: [ADR 0022](adr/0022-external-oidc-authentication.md);
roles and permissions follow [doc 020 §12](020-production-core-v0.1.md) and this document.

## 1. What this milestone delivers

- Sign-in through an external OIDC identity provider — **WorkOS AuthKit** behind a provider
  boundary (`apps/api/src/identity`); the code is exchanged server-to-server and the access token
  is verified strictly (section 5a) before anything is trusted.
- AYVO users, their link to the external identity, roles, permissions, warehouse scopes, AYVO
  application sessions and a security audit — all in PostgreSQL, evaluated by the API on **every
  request**.
- A global NestJS guard: **deny by default**; every route declares `@Public()`,
  `@Authenticated()` or `@RequirePermission(…)`; an undeclared route is refused (and a test fails).
- Next.js: every internal page requires a signed-in, active user; navigation and pages follow the
  permissions; the API stays the security boundary (a hidden button is never the protection).
- Czech pages: sign-in, "Nemáte oprávnění", "Účet není aktivní" / "Účet nemá přístup", "Relace
  vypršela"; user and role administration with reasons and audit; sign-out.
- One-time, audited bootstrap of the first administrator.
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

## 3. Data model (migrations `20261011190000_identity_access` and `20261012090000_identity_permission_refinements`, additive)

| Table                | Purpose and database rules                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | AYVO user: e-mail (lower-case, unique, immutable), display name, `ACTIVE`/`DEACTIVATED` (fields consistent by CHECK), last login; never deleted      |
| `user_identities`    | external identity link (provider `WORKOS`/`TEST`, subject); one active link per subject and per (user, provider); closes once; never deleted         |
| `roles`              | catalogue (8 roles, seeded); changes only by migration                                                                                               |
| `permissions`        | catalogue (15 permissions, seeded) incl. `warehouse_scoped`; changes only by migration                                                               |
| `role_permissions`   | role → permission (seeded); changes only by migration                                                                                                |
| `user_roles`         | grants with grantor and reason; revocation closes once with revoker and reason; one open grant per (user, role); never deleted                       |
| `user_scopes`        | `WAREHOUSE` (inventory location) now; `HOTEL_ORGANIZATION` / `HOTEL_SITE` reserved for the hotel modules; closes once; never deleted                 |
| `user_sessions`      | AYVO sessions: only the SHA-256 of the 256-bit cookie token, idle and absolute expiry, revocation once (reason); only activity/revocation may change |
| `auth_login_states`  | one-time OAuth state (hash), browser binding (hash), PKCE verifier, safe next path, 10-minute expiry                                                 |
| `identity_bootstrap` | the single bootstrap of the first administrator — one row ever (primary key `true`), immutable                                                       |
| `audit_events`       | append-only security/administration audit (UPDATE/DELETE/TRUNCATE rejected)                                                                          |

The second migration only INSERTs the three permissions of the owner review (prices, supplier
documents, stock summary) and their role grants, and updates four role descriptions (text only);
nothing is deleted or revoked. Existing data is untouched; no user is invented. After migration nobody can sign in until the
administrator is bootstrapped (section 8).

## 4. Roles and permissions

| Permission                     | Scoped | ADMIN | WH_OP | WH_SUP | PROD_OP | PROD_SUP | SALES | FINANCE | HOTEL |
| ------------------------------ | :----: | :---: | :---: | :----: | :-----: | :------: | :---: | :-----: | :---: |
| `identity:users_read`          |        |   ✓   |       |        |         |          |       |         |       |
| `identity:users_manage`        |        |   ✓   |       |        |         |          |       |         |       |
| `inventory:read`               |   ✓    |   ✓   |   ✓   |   ✓    |    ✓    |    ✓     |       |    ✓    |       |
| `inventory:stock_summary`      |   ✓    |   ✓   |       |        |         |          |   ✓   |         |       |
| `inventory:receive`            |   ✓    |   ✓   |   ✓   |   ✓    |         |          |       |         |       |
| `inventory:correct`            |   ✓    |   ✓   |       |   ✓    |         |          |       |         |       |
| `inventory:items_manage`       |   ✓    |   ✓   |       |   ✓    |         |          |       |         |       |
| `procurement:suppliers_manage` |   ✓    |   ✓   |       |   ✓    |         |          |       |         |       |
| `procurement:cost_read`        |        |   ✓   |       |        |         |          |       |    ✓    |       |
| `procurement:documents_read`   |        |   ✓   |       |   ✓    |         |          |       |    ✓    |       |
| `production:read`              |        |   ✓   |       |        |    ✓    |    ✓     |       |         |       |
| `production:bottles_create`    |        |   ✓   |       |        |         |    ✓     |       |         |       |
| `production:labels_print`      |        |   ✓   |       |        |    ✓    |    ✓     |       |         |       |
| `production:templates_manage`  |        |   ✓   |       |        |         |    ✓     |       |         |       |
| `production:label_apply`       |   ✓    |   ✓   |       |        |         |    ✓     |       |         |       |

A user may hold several roles. **Scoped** permissions also need a `WAREHOUSE` scope for the
warehouse the operation acts on (today always `MAIN`).

- **ADMIN sees and manages the whole system** (owner decision) — through ordinary
  `role_permissions` rows, never a code bypass: the guard, the warehouse scopes and the
  last-administrator protection apply to ADMIN like to anyone. The bootstrap grants the first
  administrator every existing warehouse scope (as data). **Every permission a future migration
  adds must be reviewed and granted to ADMIN explicitly** — `test/identity.e2e.test.ts` compares
  the database matrix with this table and fails otherwise.
- **Purchase prices** (`unitPrice`, `currency`, `vatRate` of receipt lines) need
  `procurement:cost_read`; **supplier documents** (the documents of a receipt, supplier document
  lists and files) need `procurement:documents_read`. Without them the API **omits** the fields
  from every receipt response (detail, create, link document, correction, idempotent replays) —
  filtered on the server (`receiptForViewer`), not only hidden in the UI. Receipt lists carry no
  prices. Uploading/linking a document and entering prices on a new receipt stay part of
  `inventory:receive` (the response is filtered the same way).
- **SALES** reads `GET /api/admin/inventory/stock-summary` only: item (code, name, unit),
  available, reserved, low stock — no lots, suppliers, prices, documents, receipts, corrections,
  movements or write actions.
- **FINANCE** reads stock and receipts (`inventory:read`) with prices and documents; no write
  action.
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
   to an AYVO user; an unlinked identity is linked only to an **ACTIVE, pre-provisioned user with
   the same provider-verified e-mail** — nobody is created automatically. Unknown → "Účet nemá
   přístup"; deactivated → "Účet není aktivní"; both audited (`LOGIN_DENIED`).
4. Success creates an AYVO session: 256 random bits in the `ayvo_session` cookie
   (`HttpOnly; Secure; SameSite=Lax; Path=/`), only its SHA-256 in the database; redirect to the
   safe `next` path (same-site paths only).
5. Every request: session lookup → expiry (idle `SESSION_IDLE_MINUTES`, default 120; absolute
   `SESSION_ABSOLUTE_HOURS`, default 12) → user status → roles, permissions and scopes **from the
   database**. A role change applies to the next request; a deactivation revokes all sessions in
   the same transaction.
6. `POST /api/auth/logout` revokes the session, clears the cookie and returns the WorkOS logout URL
   (ends the provider session) or `/login?signed_out=1`.

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

## 6. Route matrix (generated from the code)

Every route not listed as public answers `401 UNAUTHENTICATED` without a session (tested for all
routes). `403 FORBIDDEN` without the permission or warehouse scope, `403 ACCOUNT_INACTIVE` for a
deactivated user, `401 SESSION_EXPIRED` after expiry, `403 CSRF_REJECTED` for a cross-site
state-changing request.

| Method | Route                                                    | Access                         |
| ------ | -------------------------------------------------------- | ------------------------------ |
| GET    | `/api/auth/callback`                                     | **public**                     |
| GET    | `/api/auth/login`                                        | **public**                     |
| GET    | `/api/auth/test-provider/authorize`                      | **public**                     |
| GET    | `/api/health`                                            | **public**                     |
| GET    | `/api/public/bottles/:token`                             | **public**                     |
| POST   | `/api/auth/logout`                                       | signed-in                      |
| GET    | `/api/auth/me`                                           | signed-in                      |
| GET    | `/api/admin/bottle-batches`                              | `production:read`              |
| GET    | `/api/admin/bottle-batches/:code`                        | `production:read`              |
| GET    | `/api/admin/bottle-batches/:code/print-jobs`             | `production:read`              |
| POST   | `/api/admin/bottle-batches/:code/print-jobs`             | `production:bottles_create`    |
| GET    | `/api/admin/bottle-creation-history`                     | `production:read`              |
| POST   | `/api/admin/bottle-registrations`                        | `production:bottles_create`    |
| GET    | `/api/admin/bottles`                                     | `production:read`              |
| GET    | `/api/admin/bottles/:code`                               | `production:read`              |
| GET    | `/api/admin/bottles/:code/physical`                      | `production:read`              |
| GET    | `/api/admin/goods-receipts`                              | `inventory:read`               |
| POST   | `/api/admin/goods-receipts`                              | `inventory:receive`            |
| GET    | `/api/admin/goods-receipts/:code`                        | `inventory:read` ¹             |
| POST   | `/api/admin/goods-receipts/:code/corrections`            | `inventory:correct`            |
| POST   | `/api/admin/goods-receipts/:code/documents`              | `inventory:receive`            |
| GET    | `/api/admin/identity/roles`                              | `identity:users_read`          |
| GET    | `/api/admin/identity/users`                              | `identity:users_read`          |
| POST   | `/api/admin/identity/users`                              | `identity:users_manage`        |
| GET    | `/api/admin/identity/users/:id`                          | `identity:users_read`          |
| POST   | `/api/admin/identity/users/:id/deactivate`               | `identity:users_manage`        |
| POST   | `/api/admin/identity/users/:id/reactivate`               | `identity:users_manage`        |
| POST   | `/api/admin/identity/users/:id/roles/grant`              | `identity:users_manage`        |
| POST   | `/api/admin/identity/users/:id/roles/revoke`             | `identity:users_manage`        |
| POST   | `/api/admin/identity/users/:id/warehouses/grant`         | `identity:users_manage`        |
| POST   | `/api/admin/identity/users/:id/warehouses/revoke`        | `identity:users_manage`        |
| GET    | `/api/admin/identity/warehouses`                         | `identity:users_read`          |
| GET    | `/api/admin/inventory/items`                             | `inventory:read`               |
| POST   | `/api/admin/inventory/items/:code/settings`              | `inventory:items_manage`       |
| GET    | `/api/admin/inventory/lots`                              | `inventory:read`               |
| GET    | `/api/admin/inventory/movements`                         | `inventory:read`               |
| GET    | `/api/admin/inventory/stock`                             | `inventory:read`               |
| GET    | `/api/admin/inventory/stock-summary`                     | `inventory:stock_summary`      |
| GET    | `/api/admin/label-applications`                          | `production:read`              |
| POST   | `/api/admin/label-applications`                          | `production:label_apply`       |
| POST   | `/api/admin/label-artworks`                              | `production:templates_manage`  |
| GET    | `/api/admin/label-artworks/:id/content`                  | `production:read`              |
| GET    | `/api/admin/label-calibration/qr-validation-sheet.pdf`   | `production:read`              |
| GET    | `/api/admin/label-designer/settings`                     | `production:read`              |
| GET    | `/api/admin/label-print-jobs/:code`                      | `production:read`              |
| POST   | `/api/admin/label-print-jobs/:code/generate`             | `production:labels_print`      |
| GET    | `/api/admin/label-print-jobs/:code/pdf`                  | `production:read`              |
| GET    | `/api/admin/label-template-versions/:id`                 | `production:read`              |
| GET    | `/api/admin/label-template-versions/:id/calibration.pdf` | `production:read`              |
| GET    | `/api/admin/label-templates`                             | `production:read`              |
| POST   | `/api/admin/label-templates`                             | `production:templates_manage`  |
| GET    | `/api/admin/label-templates/:id`                         | `production:read`              |
| POST   | `/api/admin/label-templates/:id/archive`                 | `production:templates_manage`  |
| POST   | `/api/admin/label-templates/:id/restore`                 | `production:templates_manage`  |
| POST   | `/api/admin/label-templates/:id/versions`                | `production:templates_manage`  |
| POST   | `/api/admin/supplier-documents`                          | `inventory:receive`            |
| GET    | `/api/admin/supplier-documents/:id/content`              | `procurement:documents_read`   |
| GET    | `/api/admin/suppliers`                                   | `inventory:read`               |
| POST   | `/api/admin/suppliers`                                   | `procurement:suppliers_manage` |
| POST   | `/api/admin/suppliers/:id/archive`                       | `procurement:suppliers_manage` |
| GET    | `/api/admin/suppliers/:id/documents`                     | `procurement:documents_read`   |

¹ Every receipt response (`GET /goods-receipts/:code`, `POST /goods-receipts`,
`…/documents`, `…/corrections`) omits prices without `procurement:cost_read` and linked documents
without `procurement:documents_read`.

Web pages: `/login`, `/forbidden`, `/account-inactive`, `/session-expired` and the bottle passport
`/q/<token>` are public; every page under the application shell requires a signed-in user;
`/warehouse/availability` needs `inventory:stock_summary`, every other `/warehouse/*` page
`inventory:read` (`/warehouse/receipts/new` also `inventory:receive`); `/production/*`,
`/bottles/*`, `/batches/*`, `/label-templates/*` need `production:read`, `/admin/*` needs
`identity:users_read` (creating users `identity:users_manage`). Navigation tabs follow the same
permissions.

## 7. Administration (`/admin/users`, ADMIN)

Create pre-provisioned users (e-mail, name, roles, warehouses), grant/revoke roles and warehouse
scopes, deactivate/reactivate. Every change requires a reason, is audited (`USER_CREATED`,
`ROLE_GRANTED`, `ROLE_REVOKED`, `SCOPE_GRANTED`, `SCOPE_REVOKED`, `USER_DEACTIVATED`,
`USER_REACTIVATED`) and applies on the user's next request. The last active administrator can
neither lose `ADMIN` nor be deactivated; nobody can deactivate themselves.

## 8. Bootstrap of the first administrator (one-time)

```bash
# inside the API container (DEV), after the migration:
node dist/identity/bootstrap-admin.js --email <owner e-mail verified in WorkOS> --name "<Name>"
```

Creates the ACTIVE user with `ADMIN` and a `WAREHOUSE` scope for every existing warehouse, and
audits `ADMIN_BOOTSTRAPPED` (with the warehouses). The owner then signs in via
WorkOS with exactly this e-mail, which links the identity. The database permits **one** bootstrap
ever (`identity_bootstrap`); the command refuses afterwards, and there is no endpoint or setting
that bootstraps.

## 9. WorkOS setup the owner must do (nothing of this is in Git)

1. Create a WorkOS account/organization; use the **Staging** environment for DEV.
2. Enable **AuthKit** (User Management). Sign-in methods (e-mail + password, magic link, passkeys)
   and **MFA** are configured there.
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
7. In WorkOS, invite/create the owner's user with the e-mail used for the bootstrap.
8. Then the DEV deployment can run (`scripts/deploy-dev.sh` refuses without the three values) and
   the one-time bootstrap (section 8).

Before production: pricing, DPA and EU data-location check of WorkOS (ADR 0022); production
environment values in the production secret store; `APP_PUBLIC_ORIGIN` of production.

## 10. Tests

- API unit: WorkOS adapter (authorization URL with state and PKCE, server-side exchange, refusal
  of foreign-key, HMAC, expired, other-subject, wrong/missing/trailing-slash issuer, wrong/missing
  client id, foreign audience, missing/empty `sid`, missing/malformed/future/inverted `iat`/`exp`,
  machine-to-machine, impersonation, agent and client-credentials tokens — each verified to fail
  for its own reason; no secrets in errors); configuration (fake provider refused outside tests,
  WorkOS key, client id and https issuer required in development and production, secrets never
  echoed).
- API integration (real migrated database): every route declares access and answers 401
  anonymously; sign-in, secure cookie, hashed token; unknown identities refused and audited;
  single-use state bound to the browser; safe redirects; permissions and warehouse scopes; no
  identity from headers; role change and deactivation effective at once; expiry; logout; CSRF;
  one-time bootstrap (with warehouse scopes); last-admin protection; append-only audit; public
  passport and health; the database role matrix equals section 4 (ADMIN holds every permission);
  prices and documents omitted for every restricted role on detail, list, create, link and
  idempotent replay, document lists and files refused; SALES gets only the four summary fields
  and is refused on every other read and write.
- Playwright: sign-in redirects back to the requested page; anonymous API 401; unknown identity;
  administration (create, grant, revoke, deactivate with reasons and audit) and its immediate
  effect in a second browser; forbidden and inactive pages; sign-out; widths 320/390/1280;
  ADMIN sees every module; a warehouse operator sees neither price nor documents on the receipt
  page or through direct API calls, FINANCE sees both; SALES sees only Sklad → Dostupnost and is
  sent to "Nemáte oprávnění" elsewhere.

## 11. Limitations and follow-ups

- **DEV activation needs the owner's WorkOS values** (section 9); until then the DEV preview stays
  on the previous release (deploy refuses).
- Rate limiting of sign-in and public endpoints is still open (ADR 0017 item 7).
- The token rules of section 5a follow WorkOS' published AuthKit session-token claims
  (`iss`, `sub`, `sid`, `client_id`, `iat`, `exp`; no `aud` by default). They are proven against
  locally signed tokens only; the first real DEV sign-in confirms them against WorkOS.
- Operational `actor_id` columns (bottle events, movements) are filled with Production Core.
- Hotel scopes, hotel SSO and the hotel portal come with the hotel modules.
- ADMIN holds every operational permission; the doc 020 §12 rule that operational actions by
  ADMIN need a mandatory reason (emergency override) is not enforced yet — it comes with the
  Production Core actions that carry actors and reasons.
- Entering prices on a new receipt is part of `inventory:receive` (the responder never gets them
  back without `procurement:cost_read`); whether entering prices should also require a cost
  permission is an owner decision.
- Session lifetimes (120 minutes idle, 12 hours absolute) are configurable defaults.
