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

## 11. Monthly run of TEST invoices (owner 2026-10-30)

Built without a new table; on the same gates as §9 (kind `TEST`, refused with
`APP_ENV=production`, nothing sent). Finance → Faktury hotelům → Měsíční běh.

- `GET /api/admin/finance/invoices/test-run/preview?month=` (`finance:invoices_test` +
  `finance:billing_read`) reads only. Every agreement with hotel, customer, rooms, price and its
  source, amount, currency, payment terms, recorded billing timing and a state:
  `READY` / `ALREADY_INVOICED` (with the number) / `BLOCKED` (the §4 gaps or `ZERO_AMOUNT`) /
  `NOT_IN_EFFECT`.
- `POST /api/admin/finance/invoices/test-run` (`finance:invoices_test`): `month`, `issuedOn` — both
  required, never filled in or derived — and the lines the user saw (as §9, at most 50; repeat the
  run for more).
  - One separate invoice per agreement.
  - Due date = issue date + the agreement's payment terms.
  - All or nothing in one transaction; `requestId` replays the same result.
  - Changed terms: `TERMS_CHANGED`; already invoiced: `ALREADY_INVOICED`; also the database
    refuses a second valid invoice per agreement and month.
- `billingTiming` is only shown: neither the period nor the date follows from it.
- One migration, only one more value of the `operation_requests.kind` CHECK.

### Proposal for approval — not built (new data model)

A saved run needs its own tables, so it waits for the owner's approval of the model:

- `billing_run_settings`, append-only versions with a reason: the issue day, which period a run
  bills (per timing), summary or separate invoices. **No default**: while a value is missing, the
  run is blocked and says which one. The values come from §7 items 1, 2 and 7.
- `billing_runs` + `billing_run_items`, append-only: who, when, period, the settings' version, the
  state of each agreement and its invoice — so a run can be reviewed afterwards and resumed without
  a second invoice.

## 12. The language of documents (owner 2026-10-30)

- **The choice:** `customer_versions.document_language` — `cs`, `en` or `de`, required on every new
  version (also a DB trigger), the same for the PDF and the invoice e-mail. Never derived from the
  country; the form has no preselected value.
- **Missing:** versions recorded before the choice stay `NULL`. Such a customer has the gap
  `CUSTOMER_LANGUAGE_MISSING`: the invoice forms and the monthly run show why, the API answers
  `422 TERMS_INCOMPLETE`. There is no fallback; a new version with a language unblocks it.
- **Frozen:** a new invoice's snapshot holds `templateVersion`, `language` and all its `texts`. A
  later change of the customer or of the texts in code affects only later invoices.
- **Older TEST invoices:** their snapshots have no language. They stay readable, the API says
  `documentLanguage: null` and the UI "starší testovací doklad bez uloženého jazyka". Their stored
  PDF is served byte for byte and the renderer refuses them, so they are never generated again.
- **The texts** (`apps/api/src/finance/invoice-texts.ts`) are a draft for the owner's review. Number
  and date formats follow the language. The labels for the company and VAT numbers and the tax
  point, and every live VAT or reverse-charge wording, are the accountant's (§7): a TEST invoice
  prints only the note that it is not a tax document.
- **Previews:** `docs/screenshots/finance/finance-invoice-pdf-{cs,en,de}.png` (synthetic).

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
