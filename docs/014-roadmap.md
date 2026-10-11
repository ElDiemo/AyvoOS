# 014 — Roadmap

This document proposes a phased delivery order for AYVO OS. The ordering is a **proposal requiring confirmation**; each phase starts only after its open business questions are answered.

Status: Draft — Phase 0 complete; Milestones 1, 2A and 2A.1 merged and on DEV; Production Core v0.1 designed (2026-10-11)

## Confirmed requirements

- Phase 0 (this task) establishes the foundation and documentation only.
- Bottle, Crate, Hotel, Delivery, Billing and ESG models are not implemented in Phase 0, and domain database models remain unimplemented until approved _(confirmed by owner 2026-10-10)_.
- Confirmed architecture decisions (2026-10-10) are recorded in the ADRs ([index](adr/README.md)); no staging environment for now; `dev.ayvo.co` is the development preview environment.
- Carrier integration is not required in the first implementation.
- Billing is not implemented yet.
- **Phase 0 (Foundation) is complete** and the DEV preview at `dev.ayvo.co` is deployed _(approved by owner 2026-10-10)_.
- **Milestone 1 — bottles + label templates + printing v0.1** requested by owner 2026-10-10 and implemented on `feat/bottle-labels-v0.1` (in review): bottle identities with public QR tokens, creation batches, `CREATED` events, label templates with immutable versions and a visual QR designer, print jobs producing one-label-per-page PDFs, minimal public passport ([016](016-bottles-and-labels.md)). **DEV only** — production blockers are listed in [016](016-bottles-and-labels.md#production-blockers). It covers the "bottle identities (QR)" part of Phase 1 and the label printing needed before Phase 2.

- **Milestone 2A — inventory foundation, supplier receiving, physical label application**
  (owner, 2026-10-11; [018](018-inbound-stock-and-label-activation.md)): exact-quantity
  inventory with an append-only ledger and protected balances, suppliers, supplier documents,
  goods receipts with lots, invoice-pending follow-up, Czech warehouse screens, and the scan that
  turns one new bottle into a labelled serialized bottle. DEV only.
- **Milestone 2A.1 — application shell and operational module separation** (owner, 2026-10-11;
  [019](019-app-shell-and-information-architecture.md), ADR 0020): AYVO OS organized by company
  functions — **Sklad** and **Výroba**; label application moved to Production and bound to a
  bottle series server-side; overview pages; Czech internal application. No schema change. DEV
  only. First production-workflow follow-up: production orders/sessions with product binding.

- **Milestone 2C — identity and access core** (owner, 2026-10-11; [021](021-identity-and-access.md),
  ADR 0022): WorkOS AuthKit sign-in behind a provider boundary, AYVO users, roles, permissions,
  warehouse scopes, sessions, deny-by-default guards, audit, user administration. DEV activation
  waits for the owner's WorkOS setup.
- **Production Core v0.1 — designed** (owner, 2026-10-11; [020](020-production-core-v0.1.md),
  ADR 0021, ADR 0022): products and recipes, crates (capacity 40, one cycle per circulation),
  production orders with material reservations, server-side work sessions, and the atomic
  production scan (activation + crate assignment). Not implemented yet.

## Sequence (owner, 2026-10-11)

1. **Documentation and ADRs** for Production Core (doc 020, ADR 0021, ADR 0022).
2. **Authentication, users, roles and server-side guards** — external OIDC (WorkOS AuthKit
   preferred), roles and permissions in AYVO's database (doc 020 §12). Required before the
   production workflows and before any pilot use; Basic Auth stays only the outer DEV gate.
3. **Catalog and crates** — products, product-label approvals, recipes, crate types, crate
   registration and labels.
4. **Production orders and material reservations.**
5. **Server-side production work sessions** (15-minute lease, supervised takeover).
6. **Atomic activation + crate assignment** (the production scan); the standalone label
   application is retired.
7. **Production UI and E2E** (Výrobní zakázky, Bedny, workstation).
8. **2B — filling:** the recipe's `FILL` stage (liquid quantity is recipe data, never a
   constant), pumps and liquids received with lots, filling per crate cycle consuming the BOM
   atomically with `FILLED`, measured variance as its own movement.
9. **Quality and component workflows:** hold resolution, scrap/rework, label replacement, pump
   replacement, body retirement, complete assembly write-off, liquid remainder disposition (doc 018
   §16).
10. **Deliveries, returns, washing** — continuing the same crate circulation cycle.
11. **Purchasing:** replenishment requests, purchase orders, on-order, receipts linked to PO lines.
12. **Sales and commissions:** effective-dated salesperson ↔ hotel assignments with immutable
    history, versioned commission plans, auditable commission claims, team views; commission basis
    pending decision (recommendation: collected revenue); margins only as labelled estimates until
    a cost methodology is approved.
13. **Full internationalization** of the application — required before external European rollout.

## Proposed phases (requires confirmation)

| Phase                              | Scope                                                                                                            | Depends on decisions about                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0 — Foundation ✅ complete         | Monorepo, dev environment, `/health`, tooling, architecture docs and ADRs, DEV preview                           | —                                                           |
| 1 — Master data & identities       | Auth + roles, products, companies/hotels/locations/contacts/contracts, bottle & crate identities (QR), audit log | QR payload/URL format, roles, contract fields, bottle sizes |
| 2 — Filling & crates               | Crate assembly in production (n/40, before filling), filling per crate cycle, bottle & crate lifecycle events    | Quality approval, fill-batch mixing                         |
| 3 — Warehouse & service deliveries | Delivery proposals (simple rule), approval, picking by crate, COMPLETE PICKING, manual shipment                  | Planning formula v1, approval process                       |
| 4 — Returns & processing           | Goods-in, sorting, routing (wash/inspect/quarantine/retire), reconciliation                                      | Routing/retirement criteria                                 |
| 5 — Carrier integration            | Carrier adapter (e.g. PPL): shipment, tracking, labels, status                                                   | Carrier contract and API access                             |
| 6 — Billing                        | Billing periods, recurring invoices, VAT, provider integration, payment status                                   | Prorating, VAT, provider                                    |
| 7 — Hotel portal                   | Authenticated portal: deliveries, invoices, circulation metrics, upcoming service                                | Portal scope, auth approach                                 |
| 8 — Passport & sustainability      | Public bottle passport, ESG exports, metrics; CO2e only after methodology                                        | Methodology, public fields                                  |

## Cross-cutting, every phase

- Tests for invariants and tenant isolation.
- Migrations reviewed; no destructive changes to history tables.
- Docs and ADRs updated alongside code.

## Open questions

- Is this ordering right for AYVO's operational launch? Is a minimal portal or billing needed earlier?
- Target dates / pilot hotel(s)?
- Will existing data (bottles, hotels, contracts in spreadsheets/other tools) need importing?
