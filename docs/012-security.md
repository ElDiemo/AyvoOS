# 012 — Security

This document describes security requirements and the proposed security architecture: tenant isolation, access control, secrets, auditing and public endpoints.

Status: Draft — foundation phase (2026-10-10)

## Confirmed requirements

- Hotel users have their own authenticated portal and must **never** have access to other hotels.
- Hotel configuration is editable only by authorized AYVO administrators.
- Full auditability.
- Secrets are never committed.
- DEV and PROD are separated ([ADR 0008](adr/0008-dev-prod-separation.md)). The current server is **DEV only**; no production customer data or production secrets belong on it _(confirmed by owner 2026-10-10)_.
- AYVO admin users will eventually require **MFA** _(confirmed by owner 2026-10-10)_.
- The public bottle QR identity is **opaque and practically unguessable** and separate from the internal ID _(confirmed by owner 2026-10-10)_.
- Reversing a bottle retirement requires an **authorized, audited correction** _(confirmed by owner 2026-10-10)_.

## Proposed design (requires confirmation)

### Roles (proposal)

| Role               | Scope                                               |
| ------------------ | --------------------------------------------------- |
| AYVO admin         | All configuration, approvals, user management       |
| Warehouse operator | Filling, crates, picking, goods-in, sorting         |
| Finance            | Contracts (read), billing, invoices, payment status |
| Hotel user         | Own hotel(s) only, read-mostly portal               |
| Public             | Bottle passport whitelist only                      |

Fine-grained permissions are checked per endpoint (NestJS guards); roles map to permissions.

### Tenant isolation

- Hotel scope is derived **server-side** from the authenticated user, never from client-provided IDs alone.
- Every hotel-portal query is filtered by the user's allowed hotel IDs in a single, central data-access layer (not ad hoc per controller).
- Automated tests for every portal endpoint assert that hotel A cannot read hotel B's data.
- Optional later hardening: PostgreSQL Row-Level Security for portal-facing tables (decision deferred).

### Authentication

- Strong password hashing (argon2id) or an external identity provider — open decision.
- Secure, HttpOnly, SameSite cookies for web sessions.
- MFA for AYVO admin users (confirmed requirement; method and rollout timing open).

### Secrets and configuration

- All secrets via environment variables; `.env*` ignored by git except `.env.example` with placeholders only.
- Configuration validated at startup with Zod; the app refuses to start with missing/invalid config.
- Separate credentials per environment; production secrets never on developer machines.

### Database

- Least privilege: the application DB role has no superuser rights; migrations run with a separate role (proposal).
- Append-only history tables: the application role is denied UPDATE/DELETE on event tables.

### Audit

- Lifecycle events ([ADR 0006](adr/0006-auditable-lifecycle-history.md)) plus a generic audit log for administrative changes and security-relevant actions (logins, role changes, exports).

### Public endpoints

- Public passport exposes only explicitly whitelisted fields.
- Public bottle QR identities are **opaque and practically unguessable** (confirmed; e.g. sufficient random entropy, never sequential or derived from the internal ID). The concrete payload/URL format is still open.
- Rate limiting (Redis-backed) on public and authentication endpoints.

### File uploads (implemented in v0.1)

- Label artwork: type detected from content (never filename/MIME), size limit (`LABEL_ARTWORK_MAX_BYTES`), raster dimension caps, SVG deny-list (scripts, event handlers, foreignObject, DOCTYPE/entities, external references), server-generated storage keys, no path traversal, served with `nosniff` and a sandboxing CSP. See [016](016-bottles-and-labels.md#artwork).

### Current state of access control (v0.1)

- No application-level authentication yet. Admin routes live under `/api/admin/*`, the public passport under `/api/public/*`. On DEV everything is behind Caddy Basic Auth, which is acceptable **for the isolated DEV environment only**.
- **Production blocker** ([ADR 0017](adr/0017-authentication-and-authorization-blocker.md), owner 2026-10-10): application-level authentication, server-side guards on every `/api/admin/*` route, deny-by-default authorization, admin / operations / read-only roles, organization/site scope, audit events for privileged mutations, and rate limiting for the public passport, authentication and mutation endpoints. No custom authentication system until the provider is selected.

### Transport and headers

- HTTPS only in production; HSTS, CSP, CORS restricted to known origins.

## Open questions

- Authentication approach (own vs. external IdP), SSO for hotel groups?
- Detailed permission matrix per role (including who may reverse a retirement); can one user belong to several hotels?
- MFA method (TOTP, WebAuthn, via IdP?) and when it becomes mandatory.
- ~~QR payload format and public URL scheme/domain~~ — [ADR 0014](adr/0014-public-qr-identity-and-url.md).
- Rate limiting of `/api/public/*` (not implemented in v0.1).
- Data retention and GDPR handling for contacts and users.
- Security logging/monitoring destination in production.
