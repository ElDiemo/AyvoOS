# 010 — Billing

This document describes the billing domain and its separation from logistics. Billing is **not implemented** in the foundation phase.

Status: Draft — foundation phase (2026-10-10)

## Confirmed requirements

- Billing and logistics are **separate domains** ([ADR 0007](adr/0007-separate-billing-from-logistics.md)) _(confirmed by owner 2026-10-10)_.
- The hotel pays according to its contract: **contracted rooms × price per room per month**. Example: 80 rooms × 399 CZK = 31 920 CZK per month.
- The basic invoice is **not** determined by the number of bottles shipped.
- Eventually supported: billing periods, recurring invoices, invoice lines, contract changes, prorating rules **if defined**, tax/VAT configuration, invoice PDF/provider integration, payment status.
- **Do not implement billing yet.**

## Proposed design (requires confirmation)

### Module

The billing module owns BillingPeriod, Invoice, InvoiceLine, payment status and provider integration. It reads contract versions from the customers module via its service interface; it does not read logistics tables to compute the basic fee.

### Invoice generation (proposal)

1. For each active contract and billing period, select the contract version(s) valid in that period.
2. Create invoice lines: contracted_rooms × price_per_room_per_month (× period length, per billing cycle).
3. Apply VAT per configuration.
4. Persist invoice in one transaction; issued invoices are immutable — corrections via credit notes / corrective invoices.

### Money

- Store amounts as integer minor units (or `numeric`) plus ISO currency; never floating point.
- Rounding rules per currency/VAT need confirmation.

### Separation from logistics

Logistics data may appear on invoices as informational content only if explicitly requested later; it never changes the base fee unless a new, documented contract rule says so.

## Open questions

- Billing cycle options (monthly in advance/arrears?).
- Prorating rules for contract start/end and room-count changes mid-period (none defined — must not be assumed).
- VAT rates, reverse charge for foreign customers, multi-currency.
- Payment terms options, dunning, late fees.
- Invoicing provider/accounting system (e.g. external invoicing service vs. own PDF), invoice numbering series.
- Any extra charges (lost bottles/crates, extra deliveries, setup fees)?
- Who approves invoices before sending?
