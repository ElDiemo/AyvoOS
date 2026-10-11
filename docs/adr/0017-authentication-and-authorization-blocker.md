# ADR 0017: Authentication and authorization — blocking decision (provider not selected)

- **Status:** **Superseded** (provider decision) by
  [ADR 0022](0022-external-oidc-authentication.md) (owner, 2026-10-11) — the requirements below
  stay in force and remain a **production blocker** until implemented
- **Date:** 2026-10-10
- **Deciders:** AYVO owner; AYVO OS lead architect

> **2026-10-11:** the provider is decided — external OIDC (WorkOS AuthKit preferred, subject to a
> pricing, DPA and EU data-location check), with users, roles, permissions, scopes and audit actors
> authoritative in AYVO's database (ADR 0022). Authentication, users, roles and guards come before
> the Production Core workflows (doc 020 §14). The original text is kept below.

## Context

Milestone 1 exposes admin routes (`/api/admin/*`) that create permanent bottle identities, upload
artwork and generate print documents. Today they have **no application-level authentication**.
On the isolated DEV preview the whole site is behind Caddy HTTP Basic Auth (ADR 0013), which the
owner accepts **for DEV only**.

## Decision

- **Do not build a custom authentication system.** The authentication provider (own vs. external
  IdP, MFA method — doc 012) is not selected yet; this ADR records the requirement and blocks
  production until it is decided and implemented.
- Before **any production or externally accessible deployment**, the application must have:
  1. application-level authentication (MFA for AYVO admins, doc 012);
  2. server-side guards on **every** `/api/admin/*` route;
  3. **deny-by-default** authorization;
  4. at least **admin**, **operations** and **read-only** role separation;
  5. organization / site scope where applicable (tenant isolation, doc 012);
  6. **audit events** for privileged mutations (registering bottles, template changes and
     archiving, print jobs);
  7. **rate limiting** for the public passport, authentication and mutation endpoints. Not
     implemented: it needs a decision on which forwarded client-IP headers are trusted across
     Caddy → Next.js SSR → API, the public QR host topology, limits and fail-open behaviour.
- The public passport stays unauthenticated and returns only its dedicated public DTO
  (`publicBottlePassportSchema`); it never reuses an internal bottle response.
- Until then: Basic Auth on DEV only; `bottle_events.actor_id` stays NULL.

## Related accepted trade-off

The production QR domain (`https://qr.ayvo.co`) is a security-policy value in code and in a
database CHECK, not configuration; changing it requires an intentional code change and a
database migration. Rationale and scope: [ADR 0014](0014-public-qr-identity-and-url.md).

## Consequences

- Milestone 1 cannot be deployed to production or any externally accessible environment.
- The route split (`/api/admin/*` vs `/api/public/*`) makes adding guards and rate limits
  mechanical once the provider is chosen.

## Open questions

- Authentication provider and MFA method; role/permission matrix; session handling.
