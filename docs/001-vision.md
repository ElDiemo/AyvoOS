# 001 — Vision

AYVO OS is the central operating system for AYVO, a premium B2B circular hotel amenity service. This document states what AYVO does, what AYVO OS must eventually support, and what is explicitly out of scope for the foundation phase.

Status: Draft — foundation phase (2026-10-10)

## The business

AYVO provides reusable premium cosmetic bottles to hotels.

- Hotels pay a fixed monthly fee per contracted room.
- Hotels do **not** refill bottles. Housekeeping swaps used/empty bottles for full ones.
- AYVO handles the whole loop: bottles, filling, reusable transport crates, delivery, collection, washing, inspection, refilling, inventory, hotel contracts, recurring service deliveries, monthly billing, shipping/carrier integration and ESG / sustainability reporting.

## Confirmed requirements

AYVO OS must eventually provide:

| Capability                    | Summary                                                                                  | Doc                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| Bottle identity & lifecycle   | Permanent digital + QR identity per bottle, full auditable history                       | [004](004-bottle-lifecycle.md)     |
| Crate logistics               | Reusable crates (capacity 40, one crate cycle per circulation) as primary logistics unit | [005](005-crate-lifecycle.md)      |
| Warehouse workflows           | Filling into crates, picking crates into deliveries, goods-in, sorting                   | [006](006-warehouse-workflows.md)  |
| Hotel master data & contracts | Companies, hotels, locations, contacts, contracts, service configuration                 | [007](007-hotels-and-contracts.md) |
| Service deliveries            | Recurring deliveries; automatic proposals requiring AYVO approval                        | [008](008-service-deliveries.md)   |
| Returns                       | Crate-level goods-in, bottle-level identification at sorting                             | [009](009-returns.md)              |
| Billing                       | Contract-based monthly billing, separate from logistics                                  | [010](010-billing.md)              |
| Sustainability                | Verified circulation metrics, public bottle passport, ESG exports                        | [011](011-sustainability.md)       |
| Hotel portal                  | Authenticated, strictly per-hotel portal                                                 | [012](012-security.md)             |

Non-negotiable qualities:

- Full auditability; lifecycle history is never silently overwritten (append-only lifecycle history) _(confirmed by owner 2026-10-10)_.
- PostgreSQL is the source of truth; Redis is never a source of truth _(confirmed by owner 2026-10-10)_.
- Modular monolith, not microservices _(confirmed by owner 2026-10-10)_.
- No full event sourcing _(confirmed by owner 2026-10-10)_.
- Billing and logistics are separate domains _(confirmed by owner 2026-10-10)_.
- Important multi-record business operations are transactional.
- No sustainability claims (e.g. CO2e) without a documented methodology.

## Environments _(confirmed by owner 2026-10-10)_

- The current server is a **DEV-only** server. No production customer data and no production secrets belong on it.
- `dev.ayvo.co` is the development preview environment.
- Production will later run on a **separate VPS**.
- No staging environment is created for now.
- See [ADR 0008](adr/0008-dev-prod-separation.md).

## What AYVO OS is not

- Not a traditional ecommerce shop: hotels receive recurring service deliveries, not ad-hoc carts.
- Not usage-based billing: the basic invoice is not determined by bottles shipped.
- Not an event-sourced system (see [ADR 0006](adr/0006-auditable-lifecycle-history.md)).

## Foundation phase scope (this phase)

In scope: monorepo, minimal Next.js + NestJS apps, PostgreSQL + Redis via Docker Compose, Prisma configured with no domain models, `/health` endpoint, linting/formatting/typecheck/tests, and this documentation set.

Out of scope: Bottle, Crate, Hotel, Delivery, Billing and ESG data models and any business functionality.

## Users (eventual)

| User                | Uses                                                |
| ------------------- | --------------------------------------------------- |
| AYVO administrators | Hotel/contract configuration, approvals, oversight  |
| Warehouse operators | Filling, crate handling, picking, goods-in, sorting |
| Finance             | Billing, invoices, payment status                   |
| Hotel users         | Hotel portal (own hotel only)                       |
| Guests / public     | Public bottle passport via QR                       |

## Proposed design (requires confirmation)

- One codebase (`apps/api`, `apps/web`, shared `packages/*`) deployed as a single backend and a single web frontend. See [ADR 0001](adr/0001-modular-monolith.md), [ADR 0003](adr/0003-nextjs-and-nestjs.md).
- Delivery in phases, see [014 — Roadmap](014-roadmap.md).

## Open questions

- Which markets/countries/currencies are in scope at launch (the brief mentions cities, regions and countries; billing example is in CZK)?
- Which languages must the UI and public passport support?
- Expected scale (hotels, bottles, crates) for the first 12–24 months?
