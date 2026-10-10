# ADR 0007: Separate billing from logistics

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

Hotels pay a fixed monthly fee per contracted room according to their
contract — for example 80 contracted rooms × 399 CZK per room per month.
The basic invoice is **not** determined by the number of bottles shipped.
Logistics (deliveries, returns, crates, bottles) and billing therefore change
for different reasons and at different times.

## Decision

- **Billing** is its own module, logically separate from logistics modules
  (`deliveries`, `returns`, `warehouse`, `assets`).
- The base invoice amount is derived from **contract data** (contracted
  room count, price per room per month, billing cycle, effective dates),
  owned by the `customers` module, never from shipment or bottle counts.
- Billing reads contract terms through the `customers` module's interface.
  Logistics modules do not write to billing tables and billing does not
  write to logistics tables.
- Contracts are versioned with effective-from / effective-to dates so that
  a billing period can always be recomputed from the terms valid at the time.
- Issued invoices are immutable; corrections use credit notes / correcting
  documents (exact legal form to be confirmed).
- Money uses exact decimal / minor units and explicit currency.
- Any future usage-based charges (if ever introduced) would be separate,
  explicitly defined invoice lines, decided in a new ADR.

## Consequences

### Positive

- Invoices are predictable and match the commercial model.
- Logistics changes (re-planning, extra deliveries) cannot accidentally
  change what a hotel is charged.
- Billing can be tested independently of warehouse workflows.

### Negative

- Contract versioning adds modelling effort up front.
- Reporting that combines billing and logistics needs explicit read models.

## Alternatives considered

- **Bill per shipped bottle/crate** — rejected: contradicts the contract
  model.
- **Billing computed directly inside delivery workflows** — rejected:
  couples unrelated concerns.

## Open questions (do not assume)

- Prorating rules for mid-period contract changes, start and termination.
- VAT rates and tax configuration; currencies other than CZK.
- Billing cycles supported (monthly only?) and invoice numbering rules.
- Invoice PDF generation / external accounting or invoicing provider.
- Payment terms, payment status tracking and dunning.
- Charges for lost or damaged bottles/crates, if any.
