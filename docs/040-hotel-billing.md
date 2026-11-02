# 040 — Finance: hotel billing (N3)

- **Status:** N3A-1 (settings) and N3A-2a (issuer) merged; N3A-2b TEST invoices (§9) for
  review. N3A-2 (live amounts, issuing), N3A-3 (UI), N3A-4 (mail, export), N3B (bank) and N3C (hotel portal) are planned
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
| Issuer — our company (legal name, address, IČO, explicit VAT status, DIČ, registration, contacts)                                      | Finance | `finance.issuer_versions` (N3A-2a, §8); the only editable place                                                 |
| Invoice bank accounts + the default per currency (not the bank connection, doc 041)                                                    | Finance | `finance.issuer_bank_accounts` + versions, `issuer_default_accounts` (N3A-2a, §8)                               |
| VAT, tax point, rounding, number series                                                                                                | Finance | N3A-2, behind the issuing gate (§5)                                                                             |
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

## 8. Our company and the invoice bank accounts (N3A-2a)

Owner 2026-10-26 (`N3-FIRMA-BANKA-QR-20261026.md`). Checked first: the core holds no invoicing
identity (a site is not a legal entity, doc 022 §1; suppliers are other companies) and the
marketing site's footer is static web text, never read by invoices. So Finance is the only place.

- **Issuer** in versions (`expectedVersion`, PK = version): legal name, address, IČO (CZ: 8 digits),
  **explicit** VAT status `VAT_PAYER | NOT_VAT_PAYER` (no default), DIČ (required for a payer),
  registration text, e-mail, phone, web; reason, author, time.
- **Invoice bank accounts** (`IB-000001`) in versions: label, currency, Czech domestic number
  (prefix / number / bank code — ČNB weights) and IBAN (mod 97; for CZ derived from the domestic
  number and must equal it), optional BIC; ACTIVE / RETIRED, never deleted.
- **Default account per currency**: a choice in revisions (counter `billing_revision`); only an
  active account of that currency; the current default is never retired or moved to another
  currency before another one is chosen (`ACCOUNT_IS_DEFAULT`).
- **Readiness** lists what of this setting blocks a live invoice (`ISSUER_MISSING`,
  `NO_DEFAULT_ACCOUNT`, `DEFAULT_ACCOUNT_RETIRED`) — never development or synthetic tests; the
  accountant's rules are separate gates.
- `finance:issuer_manage` (ADMIN only) reads and changes it — no other role is given this
  configuration. Audit = the versions. Page Finance → Naše firma a účty.
- Issuing (N3A-2b) freezes the issuer, the account and the payment instructions into the invoice;
  a later change never alters an issued PDF or its QR payment (ČBA/SPAYD, CZK only, generated
  locally with the existing `qrcode` library).

## 9. TEST invoices (N3A-2b, owner 2026-10-27)

A testable chain on DEV — settings → invoice with PDF and QR Platba — **without live issuing**: only
kind `TEST` exists (DB CHECK), the API refuses it with `APP_ENV=production`, nothing is sent.

- `POST /api/admin/finance/invoices/test` (`finance:invoices_test`, ADMIN): month + agreements of
  **one customer** (one = a separate invoice, several = a summary with a line per hotel). Each
  agreement must be in effect for the whole month with a price (no gap: `TERMS_INCOMPLETE`);
  one currency and the same payment terms. Line = billed rooms × price (exact); total = Σ lines.
- Number `T<year>-<serial 5>` and VS `99<year><serial 4>` from their own counter — never a live
  series. Due date = issue date (Prague) + payment terms.
- Frozen in `invoices.snapshot`: issuer (newest version), customer version, the default account of
  the currency (active), lines, payment instructions. The PDF (watermark "TESTOVACÍ DOKLAD —
  NEPLATNÝ", QR Platba, "DPH a účetní pravidla zatím nejsou schválena") is rendered from it,
  stored create-only and identified by SHA-256 (checked on every download).
- At most one valid TEST invoice per agreement and month (DB); `POST …/:number/cancel` with a
  reason is a separate record — the invoice never changes; the month may then be invoiced again.
- `GET /api/admin/finance/invoices`, `…/:number`, `…/:number/pdf` (`finance:invoices_read`). UI
  Finance → Faktury.

## 10. Hotel groups, summary invoicing and the portal — proposal (not built)

- A hotel is not a company, and a **group** (e.g. a chain) is neither: it is a commercial grouping
  of hotels that may belong to several companies. Proposed in the core next to hotels
  (`hotel_groups`, append-only memberships with validity); Finance would only read it — never
  derive the payer or the price from it.
- Billing stays per **customer**: rooms and price belong to the hotel's agreement; one invoice never
  mixes customers. A summary invoice = several agreements of the same customer (supported by the
  invoice model now); whether a customer gets separate or summary invoices is an accountant
  decision (§7 item 7), proposed as a versioned choice on the customer. A group overview across
  companies is a report, not a document.
- The future portal (N3C) needs two axes: **where** (hotels or a group — operations) and **for
  whom it pays** (customers — invoices and payments). A group manager never sees the invoices of a
  company they do not act for.

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

## 13. Live invoicing: one monthly tax document per agreement (owner 2026-11-02, "as UOL")

Approved by the owner on 2026-11-02; it replaces the earlier proposal of a default advance-payment
cycle. A decision of scope, **not built**: the gate of §5 stays closed and nothing here enables
live issuing, a scheduler, real sending or a bank call.

**Scope (binding):**

- **One regular monthly invoice per agreement, a tax document:** billed rooms × the agreement's
  own price, otherwise the valid default price list (§3). It carries the right payer (the
  customer's version), the billed period, currency, due date, VS and QR Platba.
- **Issued and sent automatically according to settings.** The issue day, the billed month's
  relation to the issue date and the due date are settings: never hard-coded and never guessed.
  For example, UOL issues on the 1st of the billed month, with the tax point on the same day and
  the due date later. The owner originally said hotels pay for the following month; the exact day
  and offset come with the settings proposal.
- **Bank:** RB is read regularly and only payments of hotel invoices are paired (doc 041 §8b). A
  person may allocate a payment with a wrong VS, with a reason. Unrelated bank income creates no
  work queue.
- **Overview:** all invoices and each hotel's invoices, paid / partially paid / unpaid / overdue,
  with the balance. Paying an ordinary invoice never creates another invoice and never changes the
  issued PDF.
- **Accountant:** issued invoices go into the accountant's handover, clearly separated from the
  received documents (doc 039 §7).
- **Not the default now:** proformas, tax documents for advance payments and their settlement. No
  model or backlog is added for them.

**Tax, only what has been verified:**

- REvolaris is a VAT payer (owner).
- Act 235/2004 Coll., §21(3): for a service, the taxable supply also arises when a tax document is
  issued earlier. §21(7) covers contractual partial supplies. The tax liability therefore does not
  wait for the bank payment.
- This does not confirm the tax treatment of our particular mix of service and refill deliveries.
  UOL confirms the nature of the supply, the tax point, the rate, rounding and the number series.
  None of them is copied from another company's example.

**Money received before the tax point** is never silently treated as an ordinary later payment. A
payment booked before the issue date of the invoice its VS names is recorded as
`PAID_BEFORE_ISSUE`. It is not allocated automatically and it is to review; a person decides by
UOL's rule (doc 041 §8b, PR #110).

**The open items of §7 on 2026-11-02:**

| §7                                             | State                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| 1. In advance or in arrears, issuing window    | decided as a setting (above); the setting itself is still to be proposed |
| 2. Partial months, mid-month room changes      | open                                                                     |
| 3. Number series                               | UOL                                                                      |
| 4. VAT, tax point, rounding, foreign customers | UOL (law above)                                                          |
| 5. PDF contents, QR payment                    | done for TEST invoices (§9); tax-document contents with UOL              |
| 6. Corrections (credit note)                   | open                                                                     |
| 7. Summary invoices                            | one invoice per agreement (above); summary invoices not now              |
| 8. E-mail sender and text                      | sender decided (doc 043 §0); the text awaits the owner                   |
| 9. PROD topology of Finance                    | Finance runs on PROD; mail topology in the approved stack                |

**Smallest missing steps to a visible DEV walk-through** (each a draft PR → independent review →
DEV → owner acceptance → the same commit on PROD):

1. The approved stack and its fixes (#109, #110 after #103) on DEV: TEST invoice, sending in
   simulation, payment, state.
2. Billing settings (§11 proposal: `billing_run_settings`, versioned, no default — a missing value
   blocks the run and says which one), for model review.
3. Recorded runs (`billing_runs` + items) and a scheduler that is off by default, creating TEST
   invoices on DEV by those settings and sending them through the doc 043 path (simulation on DEV).
4. Issued invoices in the accountant's export, separated from received documents.
5. The RB read scheduler (#94) on top of #110, off by default.
6. The live tax document (kind, series, tax point, VAT, rounding), only after UOL's answers, behind
   the §5 gate.
