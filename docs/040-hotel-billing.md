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

### Run settings (owner 2026-11-02, "as UOL" — doc 040 §13 on its PR; TEST only)

`billing_run_settings`, append-only versions with a reason; the newest applies. **No default**:
without a version nothing is planned and the page says so.

| Value                  | Choices                         | Meaning                                                              |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `issue_day`            | 1–28                            | the day of the issue month an invoice is issued (every month has it) |
| `advance_billed_month` | `ISSUE_MONTH`, `NEXT_MONTH`     | the month an ADVANCE agreement's invoice bills                       |
| `arrears_billed_month` | `PREVIOUS_MONTH`, `ISSUE_MONTH` | the month an ARREARS agreement's invoice bills                       |

The due date is not a setting: issue date + the agreement's payment terms, as before. One invoice
per agreement (§13); summary invoices are not part of the settings.

- `GET/POST /api/admin/finance/billing/run-settings` (`finance:billing_read` / `finance:billing_manage`;
  the form names the revision it saw, else 409 `CONCURRENT_CHANGE`; idempotent per `requestId`).
- `GET /api/admin/finance/invoices/test-run/plan?issueMonth=` (`finance:invoices_test` +
  `finance:billing_read`): the issue date and, per billing timing, the billed month. Reads only.
- Měsíční běh shows the settings and the plan; each billed month opens the run with its period,
  issue date and timing filled in (only the agreements of that timing). **The person still loads,
  reviews and confirms**; the run itself is unchanged (§11 above) and checks everything again.

**Not built** (next steps of §13): recorded runs (`billing_runs` + `billing_run_items`,
append-only: who, when, period, the settings' revision, the state of each agreement and its
invoice), a scheduler (off by default) and automatic sending. The settings decide nothing for live
invoices, which stay behind the §5 gate; the example values in the tests are synthetic.

## 12. The language of documents (owner 2026-10-30)

- **The choice:** `customer_versions.document_language` — `cs`, `en` or `de`, required on every new
  version by the API (in the database only after §12a), the same for the PDF and the invoice e-mail. Never derived from the
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

### 12a. Rollout and rollback of the language column (reviews LANG96-R1, R2)

Rolling back images never reverts a migration, and the image before this release inserts customer
versions without `document_language`. The steps follow what the deployment scripts actually do:
Finance runs the image of the API (`pin_finance_images`), `--finance` is refused unless the OS already
runs that release, and an OS deployment leaves the running Finance alone. **So the OS and the web go
first, Finance second; Finance first is not possible**, and that release check stays.

1. **Expand (this release).** The migration only adds the nullable column and its value check, and it
   runs in step 3 below. The previous image keeps working on the migrated database; what it writes
   stays `NULL`, i.e. `CUSTOMER_LANGUAGE_MISSING` until a person chooses. Nothing is guessed, no history
   is rewritten.
2. **Upgrade, OS:** `scripts/deploy-prod.sh --release <commit>`. The new web now runs with the old
   Finance: the **Finance window**, see the table. The script names it at the end.
3. **Upgrade, Finance, right after:** `scripts/deploy-prod.sh --finance --release <commit>` (backup,
   migration, only the `finance` container). Finance is down for the backup; its pages say so.
4. **Return, before step 5, in this order:** `scripts/deploy-prod.sh --rollback <release>`, then
   `scripts/deploy-prod.sh --finance-rollback <release>`. No migration runs. Saving a customer in the
   first step's short window is refused visibly; afterwards it works and stores `NULL`; after another
   upgrade a person chooses the language with a new version.
5. **Enforce, a later release:** only after the owner closes the rollback window for images older
   than step 1. Its own migration adds a `BEFORE INSERT` trigger refusing `NULL` on new versions (old
   `NULL` rows stay valid), with a test, and is not part of this PR. Rolling it back is a forward
   migration dropping the trigger, applied before any image older than step 1 is started.

**The Finance window is a bounded closure of the billing part of Finance, not a supported way to
work.** Keep it to the minutes between steps 2 and 3. Hotels, orders and logistics do not read Finance.

| Web | Finance | When                 | Result                                                                                                                                                                                                                                                                                                                                  |
| --- | ------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new | new     | target               | everything                                                                                                                                                                                                                                                                                                                              |
| new | old     | steps 2–3            | a page whose answer lacks the language says so (`/finance/version-mismatch`), no retry advice; saving a customer is refused before anything is sent unless `GET …/finance/health/capabilities` answers `documentLanguage: true` within 5 s (404 there; an outage refuses too), because the old Finance would drop the language silently |
| old | new     | first half of step 4 | reads work; saving a customer is refused with a visible error, nothing stored                                                                                                                                                                                                                                                           |
| old | old     | after step 4         | everything; a customer's new version has no language (`NULL`); the PDF is unchanged                                                                                                                                                                                                                                                     |

Real processes of this build and of the release returned to on a synthetic database:
`apps/web/e2e-compat/rollout-window.spec.ts` (`playwright.compat.config.ts`, not in CI, it needs a built
earlier worktree). The branches of the scripts: `apps/api/test/deploy-prod-finance-order.test.ts`, with
the real script text and a stub of Docker. No real deployment has run this.

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

## 14. Hotel portal: the customer's issued invoices (owner 2026-11-02; backlog, not built)

Recorded as a requirement for a separate delivery after the internal walk-through of §13 (hotel →
one monthly invoice → e-mail → payment from RB) has been accepted. Nothing of it exists today:
everything in Finance is the **internal** administration on `os.ayvo.co` (tailnet only, ADR 0033).
There is no hotel portal, and no hotel user can sign in.

**Requirement:**

- A customer user sees the invoices they are allowed to see, each with its payment state and its
  PDF.
- By period and among their allowed hotels, the user downloads a ZIP with the PDFs and a short
  overview (`manifest.csv`). A summary invoice covering several hotels is included **once**.
- **Access to an invoice is granted explicitly for its billing payer and scope.** A right to a
  hotel alone never grants every invoice of the payer, nor other hotels: a summary invoice may
  contain other hotels, so the whole document is shown only to a user explicitly allowed for that
  payer and scope.
- Hiding links is not enough. The list, the detail, the PDF and the ZIP each check access on the
  server, in one central layer (doc 012), with tests that one customer or hotel never reads
  another's.
- The ZIP has bounds (number of documents, bytes, period) and is built outside DB transactions,
  as the export of doc 039 §7.
- This is the customer's package of **issued** invoices. It is not the accountant's export of
  received documents (doc 039) and does not replace it.

**Decisions needed before implementation** (a short concrete proposal, never an automatic change of
infrastructure, DNS or the edge):

1. **Exposure:** `os.ayvo.co` is tailnet only (ADR 0026/0033). The portal needs a public host and
   edge, its own ADR, and Codex for DNS and edge after the owner's approval.
2. **Identity:** `HOTEL_USER` is a planned, non-assignable role (doc 021 §4c). The portal needs
   external customer users: the native sign-in (ADR 0037 — invitation, password, TOTP) or another
   method, with its own session policy, separated from staff.
3. **Model of access:** grants of a portal user to a billing payer (customer) and, within it, to
   hotels. This is a new data model for the owner's review (§10 already proposes the two axes).
4. **Boundary to Finance:** the portal reads invoices only through an explicit contract (ADR 0039).
   Finance never reads core tables; whether the portal is part of the shared web app or its own
   app is an architecture decision.
5. **Payment-state wording** shown to a customer, and whether overdue is shown.
