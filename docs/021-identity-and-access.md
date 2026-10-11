# 021 — Identity and access (Milestone 2C)

Status: **Implemented on branch `feat/identity-access-core` — DEV activation pending the owner's
WorkOS setup** (section 9). Decision: [ADR 0022](adr/0022-external-oidc-authentication.md);
roles and permissions follow [doc 020 §12](020-production-core-v0.1.md) and this document.

## 1. What this milestone delivers

- Sign-in through an external OIDC identity provider — **WorkOS AuthKit** behind a provider
  boundary (`apps/api/src/identity`); the code is exchanged server-to-server and the access token
  is verified (client-specific JWKS signature, expiry, subject, optional issuer) before anything
  is trusted.
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

## 3. Data model (migration `20261011190000_identity_access`, additive)

| Table                | Purpose and database rules                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | AYVO user: e-mail (lower-case, unique, immutable), display name, `ACTIVE`/`DEACTIVATED` (fields consistent by CHECK), last login; never deleted      |
| `user_identities`    | external identity link (provider `WORKOS`/`TEST`, subject); one active link per subject and per (user, provider); closes once; never deleted         |
| `roles`              | catalogue (8 roles, seeded); changes only by migration                                                                                               |
| `permissions`        | catalogue (12 permissions, seeded) incl. `warehouse_scoped`; changes only by migration                                                               |
| `role_permissions`   | role → permission (seeded); changes only by migration                                                                                                |
| `user_roles`         | grants with grantor and reason; revocation closes once with revoker and reason; one open grant per (user, role); never deleted                       |
| `user_scopes`        | `WAREHOUSE` (inventory location) now; `HOTEL_ORGANIZATION` / `HOTEL_SITE` reserved for the hotel modules; closes once; never deleted                 |
| `user_sessions`      | AYVO sessions: only the SHA-256 of the 256-bit cookie token, idle and absolute expiry, revocation once (reason); only activity/revocation may change |
| `auth_login_states`  | one-time OAuth state (hash), browser binding (hash), PKCE verifier, safe next path, 10-minute expiry                                                 |
| `identity_bootstrap` | the single bootstrap of the first administrator — one row ever (primary key `true`), immutable                                                       |
| `audit_events`       | append-only security/administration audit (UPDATE/DELETE/TRUNCATE rejected)                                                                          |

Existing data is untouched; no user is invented. After migration nobody can sign in until the
administrator is bootstrapped (section 8).

## 4. Roles and permissions

| Role                    | Permissions                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`                 | `identity:users_read`, `identity:users_manage` — users, roles, configuration; no routine operational permissions                                     |
| `WAREHOUSE_OPERATOR`    | `inventory:read`, `inventory:receive`                                                                                                                |
| `WAREHOUSE_SUPERVISOR`  | `inventory:read`, `inventory:receive`, `inventory:correct`, `inventory:items_manage`, `procurement:suppliers_manage`                                 |
| `PRODUCTION_OPERATOR`   | `production:read`, `production:labels_print`, `inventory:read`                                                                                       |
| `PRODUCTION_SUPERVISOR` | `production:read`, `production:labels_print`, `production:bottles_create`, `production:templates_manage`, `production:label_apply`, `inventory:read` |
| `SALES`, `FINANCE`      | none yet (their modules do not exist)                                                                                                                |
| `HOTEL_USER`            | none in the internal application (the hotel portal is a separate environment)                                                                        |

A user may hold several roles. `inventory:*`, `procurement:*` and `production:label_apply` are
**warehouse-scoped**: the user also needs a `WAREHOUSE` scope for the warehouse the operation acts
on (today always `MAIN`). The standalone label application is supervisor-only until the
production scan replaces it (doc 020). The Production Core permissions of doc 020 §12 are added by
their own migrations when those features are built.

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
| GET    | `/api/admin/goods-receipts/:code`                        | `inventory:read`               |
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
| GET    | `/api/admin/supplier-documents/:id/content`              | `inventory:read`               |
| GET    | `/api/admin/suppliers`                                   | `inventory:read`               |
| POST   | `/api/admin/suppliers`                                   | `procurement:suppliers_manage` |
| POST   | `/api/admin/suppliers/:id/archive`                       | `procurement:suppliers_manage` |
| GET    | `/api/admin/suppliers/:id/documents`                     | `inventory:read`               |

Web pages: `/login`, `/forbidden`, `/account-inactive`, `/session-expired` and the bottle passport
`/q/<token>` are public; every page under the application shell requires a signed-in user;
`/warehouse/*` needs `inventory:read`, `/production/*`, `/bottles/*`, `/batches/*`,
`/label-templates/*` need `production:read`, `/admin/*` needs `identity:users_read` (creating
users `identity:users_manage`).

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

Creates the ACTIVE user with `ADMIN` and audits `ADMIN_BOOTSTRAPPED`. The owner then signs in via
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
   # optional, once confirmed from a real token:
   WORKOS_JWT_ISSUER=…
   ```
7. In WorkOS, invite/create the owner's user with the e-mail used for the bootstrap.
8. Then the DEV deployment can run (`scripts/deploy-dev.sh` refuses without the two values) and
   the one-time bootstrap (section 8).

Before production: pricing, DPA and EU data-location check of WorkOS (ADR 0022); production
environment values in the production secret store; `APP_PUBLIC_ORIGIN` of production.

## 10. Tests

- API unit: WorkOS adapter (authorization URL with state and PKCE, server-side exchange, refusal
  of foreign-key / expired / other-subject / wrong-issuer tokens, no secrets in errors);
  configuration (fake provider refused outside tests, WorkOS required, secrets never echoed).
- API integration (real migrated database): every route declares access and answers 401
  anonymously; sign-in, secure cookie, hashed token; unknown identities refused and audited;
  single-use state bound to the browser; safe redirects; permissions and warehouse scopes; no
  identity from headers; role change and deactivation effective at once; expiry; logout; CSRF;
  one-time bootstrap; last-admin protection; append-only audit; public passport and health.
- Playwright: sign-in redirects back to the requested page; anonymous API 401; unknown identity;
  administration (create, grant, revoke, deactivate with reasons and audit) and its immediate
  effect in a second browser; forbidden and inactive pages; sign-out; widths 320/390/1280.

## 11. Limitations and follow-ups

- **DEV activation needs the owner's WorkOS values** (section 9); until then the DEV preview stays
  on the previous release (deploy refuses).
- Rate limiting of sign-in and public endpoints is still open (ADR 0017 item 7).
- WorkOS access-token issuer is verified only when `WORKOS_JWT_ISSUER` is set (signature with the
  client-specific JWKS, expiry and subject are always verified).
- Operational `actor_id` columns (bottle events, movements) are filled with Production Core.
- Hotel scopes, hotel SSO and the hotel portal come with the hotel modules.
- Emergency overrides by ADMIN (doc 020 §12) are not implemented: ADMIN has no operational
  permissions.
- Receipt prices are visible to everyone with `inventory:read` (a price-specific permission is a
  follow-up).
- Session lifetimes (120 minutes idle, 12 hours absolute) are configurable defaults.
