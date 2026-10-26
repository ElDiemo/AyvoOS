# 040 — Finance: hotel billing (N3)

- **Status:** N3A-1 (settings) implemented for review — not merged, not deployed. N3A-2 (amounts,
  issuing, PDF), N3A-3 (UI), N3A-4 (mail, export), N3B (bank) and N3C (hotel portal) are planned
  separately. **Live invoicing stays blocked until the owner approves the accounting rules.**
- **Owner:** requested 2026-10-25 (`N3-HOTEL-BILLING-OWNER-20261025.md`); direction approved, N3A-1
  started in a working branch ("pod dál", 2026-10-25). Business model: ADR 0007 — the monthly base
  is billed rooms × price per room and month, never bottles shipped.
- **Runtime:** the Finance unit (ADR 0039). Finance owns the data below in schema `finance`; the
  hotel itself stays in the core and is read only through the contract.

## 1. Data ownership — one owner, no second editable copy

| Data                                                                                                                                   | Owner   | Where                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| Hotel (permanent id, code, name, address)                                                                                              | core    | `public.hotels`; Finance reads `/api/internal/v1/finance/hotels` (+ `hotels/lookup`), identity and address only |
| Customer — the billed company (legal name, IČO, DIČ, address, billing e-mail)                                                          | Finance | `finance.customers` + `customer_versions`                                                                       |
| Hotel billing agreement — customer, billed rooms, own price or the default, currency, payment terms, in advance / in arrears, validity | Finance | `finance.billing_agreements` (one per hotel) + `agreement_versions`                                             |
| Default price list — currency, price per room and month, effective month                                                               | Finance | `finance.price_list_versions`                                                                                   |
| Issuer, VAT, tax point, rounding, number series                                                                                        | Finance | N3A-2, behind the issuing gate (§5)                                                                             |
| Invoice — immutable snapshot + PDF                                                                                                     | Finance | N3A-2                                                                                                           |
| Payments                                                                                                                               | Finance | N3B                                                                                                             |

A hotel is not a company: one company may run several hotels, and an IČO never identifies a hotel.

## 2. Versions — append-only, bitemporal

- Every change or correction is a new row with `recorded_at` / `recorded_by` / `reason`; nothing is
  updated or deleted (DB triggers, also for the schema owner; the runtime role has SELECT/INSERT only).
- Agreement and price versions carry `effective_from` (the first day of a month — DB CHECK; mid-month
  changes are not decided).
- **Effective version for month P** = the greatest `effective_from ≤` first day of P, then the
  highest `revision`. Revisions come from the gapless counter `billing_revision`, whose row stays
  locked until the writing transaction commits: they follow the commit order and are never tied, so
  the result never depends on the read order or on two rows sharing a millisecond (review
  N3A74-R1). Every read — history, price list, effective terms, `asOf` — orders by it.
- **As known at moment T** = the same with `recorded_at ≤ T`. This is the API `asOf`.
  `recorded_at` is `clock_timestamp()`, taken after that lock, so it never runs against the revisions.
- Customer versions are ordered by number; the newest one known at T is used.
- **No stale form writes back older values** (review N3A74-R2). A new version is always a whole
  form, so the request names what it was edited from: `expectedVersion` (customer),
  `expectedRevision` (agreement: its newest revision; default price: the newest revision of that
  currency and month, `null` = none yet). If something newer exists → 409 `CONCURRENT_CHANGE`,
  nothing written; reload and save again. The expected value is part of the idempotency
  fingerprint. Atomic without UPDATE or row locks on versions: customers through the primary key
  (customer, version), agreements and prices through the locked `billing_revision` counter row.

## 3. Prices

- Exact decimals: `NUMERIC(19,2)` in the DB, decimal strings in the API (at most 2 decimals; more is
  refused, never rounded). Billed rooms are an integer ≥ 1.
- The price is the agreement's own price (an explicit `0.00` is a price), else the default price list
  **of the same currency** effective for P. No list means `PRICE_MISSING` — never a hard-coded
  default, never 0. No currency conversion.

## 4. Terms effective for a month (N3A-1, read only, no amounts)

`GET /api/admin/finance/billing/agreements/effective?month=YYYY-MM[&asOf=ISO]` lists every
agreement known at T with:

- `status` (`IN_EFFECT` / `NOT_IN_EFFECT`);
- the effective version, the customer's details then, and the price source (`OWN` / `DEFAULT` /
  `MISSING`);
- `gaps`:
  - `NO_EFFECTIVE_VERSION`: the validity reaches into P, but terms start later;
  - `PRICE_MISSING`;
  - `PARTIAL_PERIOD_RULE_MISSING`: the agreement covers P only partly — no proration rule is
    decided, so nothing is prorated and nothing is skipped silently.

## 5. Issuing (N3A-2, design for review — `REVIEW-N3A-PLAN-20261025.md`)

- One DB transaction:
  1. idempotency row;
  2. issuing gate;
  3. lock the series' counter row (a table row, not a sequence — it rolls back with the transaction);
  4. invoice snapshot;
  5. render the PDF deterministically;
  6. `FileStorage.put` (create-only);
  7. store its hash;
  8. commit (a deferred trigger refuses an invoice without a PDF).
- One base invoice per (agreement, month) — DB unique.
- Corrections are separate documents; issued documents never change.
- **Gate, three independent locks:**
  - complete issuer rules (DB CHECK);
  - the accounting confirmation (separate permission);
  - `FINANCE_INVOICE_ISSUING` unset on PROD.

  Outside production every PDF is watermarked.

## 6. API (N3A-1) and permissions

Under `/api/admin/finance/billing`. Every write takes a `requestId`: the same id with the same
payload replays, another payload is `IDEMPOTENCY_CONFLICT`.

- `finance:billing_read`:
  - `GET hotels` (from the core);
  - `GET customers`, `customers/:code`;
  - `GET price-list`;
  - `GET agreements`, `agreements/effective`, `agreements/:code`.
- `finance:billing_manage`:
  - `POST customers`, `customers/:code/versions` (a reason is required);
  - `POST price-list`;
  - `POST agreements` (the hotel must exist in the core; one agreement per hotel: `AGREEMENT_EXISTS`);
  - `POST agreements/:code/versions`.

Both permissions belong to ADMIN only, added by a catalogue migration. The core contract
`hotels` / `hotels/lookup` also needs `finance:billing_read`.

## 7. Open — blocks live issuing, not development (owner + accountant)

1. In advance or in arrears, and the issuing window.
2. Partial months; mid-month room changes.
3. Number series next to iDoklad (format, start).
4. VAT, tax point and rounding; foreign customers (reverse charge).
5. PDF contents; QR payment.
6. Corrections (credit note).
7. Summary invoices for several hotels of one company.
8. E-mail sender and text.
9. The PROD topology of Finance.

The questionnaire is `DOTAZNIK-UCETNI-FAKTURACE-20261025.md` (outside the repository).
