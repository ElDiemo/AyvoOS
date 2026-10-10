# 014 — Roadmap

This document proposes a phased delivery order for AYVO OS. The ordering is a **proposal requiring confirmation**; each phase starts only after its open business questions are answered.

Status: Draft — Phase 0 complete; Milestone 1 implemented as DEV-only, in review (2026-10-10)

## Confirmed requirements

- Phase 0 (this task) establishes the foundation and documentation only.
- Bottle, Crate, Hotel, Delivery, Billing and ESG models are not implemented in Phase 0, and domain database models remain unimplemented until approved _(confirmed by owner 2026-10-10)_.
- Confirmed architecture decisions (2026-10-10) are recorded in the ADRs ([index](adr/README.md)); no staging environment for now; `dev.ayvo.co` is the development preview environment.
- Carrier integration is not required in the first implementation.
- Billing is not implemented yet.
- **Phase 0 (Foundation) is complete** and the DEV preview at `dev.ayvo.co` is deployed _(approved by owner 2026-10-10)_.
- **Milestone 1 — bottles + label templates + printing v0.1** requested by owner 2026-10-10 and implemented on `feat/bottle-labels-v0.1` (in review): bottle identities with public QR tokens, creation batches, `CREATED` events, label templates with immutable versions and a visual QR designer, print jobs producing one-label-per-page PDFs, minimal public passport ([016](016-bottles-and-labels.md)). **DEV only** — production blockers are listed in [016](016-bottles-and-labels.md#production-blockers). It covers the "bottle identities (QR)" part of Phase 1 and the label printing needed before Phase 2.

## Proposed phases (requires confirmation)

| Phase                              | Scope                                                                                                            | Depends on decisions about                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0 — Foundation ✅ complete         | Monorepo, dev environment, `/health`, tooling, architecture docs and ADRs, DEV preview                           | —                                                           |
| 1 — Master data & identities       | Auth + roles, products, companies/hotels/locations/contacts/contracts, bottle & crate identities (QR), audit log | QR payload/URL format, roles, contract fields, bottle sizes |
| 2 — Filling & crates               | Fill batches, filling workflow (n/20), crate completion/verification, bottle & crate lifecycle events            | Quality approval, fill-batch mixing                         |
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
