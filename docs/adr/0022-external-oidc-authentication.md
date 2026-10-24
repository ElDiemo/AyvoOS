# ADR 0022: Authentication through an external OIDC provider; authorization in AYVO OS

> Owner decision 2026-10-23: replace the external provider with native AYVO password/TOTP
> authentication. See [implementation scope and status](../native-authentication-work.md).
> This ADR records the historical/deployed design; the native replacement is not deployed yet.

- **Status:** Accepted — confirmed by owner 2026-10-11; implemented in Milestone 2C
  ([doc 021](../021-identity-and-access.md)); DEV activation pending the owner's WorkOS setup;
  still a production blocker until verified in production (doc 016)
- **Date:** 2026-10-11
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes:** the provider decision left open by
  [ADR 0017](0017-authentication-and-authorization-blocker.md); ADR 0017's security requirements
  remain in force.

## Context

ADR 0017 blocked production until an authentication provider is chosen and application
authentication, deny-by-default guards, roles, scope, audit and rate limiting exist. Production
Core (doc 020) needs a real actor on every state-changing production event before pilot use, and
role-based operations (supervisor approvals, session takeover, corrections below reserved
quantities). Later the hotel portal needs hotel SSO and strict tenant isolation (doc 012).

## Decision

1. **Authentication** uses an external, standards-based **OIDC** identity provider. Preferred:
   **WorkOS AuthKit** — subject to a final pricing, DPA and European data-location check before
   production. The provider handles sign-in, its sessions, invitations, MFA/passkeys/magic
   authentication and future hotel SSO.
2. **AYVO PostgreSQL stays authoritative** for the internal user profile and active/deactivated
   state, operational roles and permissions, access scopes (warehouses, hotel organizations, hotel
   sites) and the audit actor identity.
3. The external subject maps to one internal AYVO user (`user_identities(provider, subject)`).
   Tokens are verified (signature, issuer, audience, expiry) on every request; **authorization is
   never derived from an unverified or external claim alone** — roles, permissions and scopes come
   from AYVO's database, and a deactivated AYVO user is refused even with a valid provider session.
4. The integration sits behind a **provider boundary** (`identity` module: one interface for
   "verify request → provider + subject"; one WorkOS adapter). Business entities reference AYVO
   users only, so the provider can be replaced without rewriting them.
5. Roles (doc 020 §12): `PRODUCTION_OPERATOR`, `PRODUCTION_SUPERVISOR`, `WAREHOUSE_OPERATOR`,
   `WAREHOUSE_SUPERVISOR`, `ADMIN`; hotel and finance roles later. Permissions are checked
   server-side, deny by default. `ADMIN` administers users, roles and configuration; operational
   actions by `ADMIN` are emergency overrides with a mandatory reason and an audit event.
   _Amended by the owner 2026-10-12 (doc 021 §4):_ `ADMIN` sees and manages the whole system and
   holds every permission — granted as ordinary `role_permissions` rows (never a code bypass;
   guards, scopes and the last-admin protection stay active); each new permission is granted to
   `ADMIN` explicitly by its migration. The mandatory-reason rule for operational ADMIN actions
   arrives with Production Core.
6. **Sequence:** authentication, users, roles and guards are implemented **before** the Production
   Core schema and workflows (doc 020 §14 step 2). Basic Auth stays only as the outer DEV gate.
7. Secrets (provider API key, client secret, cookie password) live in the server env file
   (`/opt/ayvo/secrets/…`), never in Git. DEV uses the provider's non-production environment and
   `dev.ayvo.co` redirect URLs only.

## Consequences

### Positive

- No custom password, MFA or session crypto in AYVO OS; hotel SSO later without a rewrite.
- Actor identity and authorization stay auditable in AYVO's own database.

### Negative

- External dependency (availability, pricing, data processing agreement, data location) — to be
  verified before production.
- Two places to administer users (invitation in the provider, roles in AYVO) until an admin UI
  ties them together.

## Alternatives considered

- **Own accounts (argon2id, TOTP)** — rejected: more security-critical code to own; harder hotel
  SSO.
- **Authorization from IdP claims/groups** — rejected: operational permissions and tenant scope
  must be authoritative in AYVO's database.

## Open questions

- Provider confirmation after the pricing, DPA and EU data-location check.
- Rate limiting topology (ADR 0017 item 7) remains open.
