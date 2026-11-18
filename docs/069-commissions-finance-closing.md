# 069 — Provize: měsíční uzávěrka ve Financích (hranice, kontrakt, mapa vstupů)

Status: **proposal for the owner's approval** (owner brief 2026-11-18). Nothing here is
implemented, migrated or switched on. Production code for Finance waits for the owner's approval
of §2–§6 (through Codex). Boundary decision: ADR 0046, addendum 2026-11-18. The core part (who gets
the commission, the bound rates) is implemented: PR 1a #192, PR 1b #193 (doc 068 §3.1–§3.3).

## 1. The rule (owner, 2026-11-18)

- **Input:** for a **closed calendar month M**, the **valid issued hotel invoices** and their
  **lines without VAT**, by the hotel's **billed period** (= M). Per line: the hotel's
  **approved first paid month**, the **recipient** in force for M and the **stored rate version**
  bound to that attribution (core, #193).
- **The hotel's payment is never used** — not for the amount, the month, the state or the
  timing. This replaces every earlier "after payment" rule (doc 068 C6, C7, Q2, Q2a, Q14, Q16;
  ADR 0046 §4 steps 3 and the "Hotel zaplatil" paragraph).
- **From the 1st of M+1:** one statement per salesperson (and currency) for M. The **admin
  approves it directly in Obchod → Provize**; until then the salesperson sees "Zpracovává se".
- **After approval** the salesperson sees their own state and **one amount to invoice**. Their
  invoice by the **10th**, the payout **plan** by the **15th**.
- **Not in this batch:** sending mail, automatic payments, bank pairing, "Vyplaceno" (doc 068 I4
  stays for a later batch), a scheduler or any new process.

## 2. Map of the real inputs (verified on `main` 09e82e7)

| Needed input                     | Real source today                                                                                                  | State                                                              | Minimal default / open rule                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invoice issued and valid         | `finance.invoices` (`issued_on`, `issued_at`) without a row in `finance.invoice_cancellations`                     | exists                                                             | valid = issued and not cancelled                                                                                                                                   |
| Live vs TEST                     | `finance.invoices.kind` — DB `CHECK (kind = 'TEST')`; issuing refused with `APP_ENV=production`                    | **only TEST exists**                                               | statement `mode` TEST \| LIVE; LIVE accepts only a **listed** live kind, which does not exist yet → no LIVE statement possible until doc 040 §5/§13 opens (**O1**) |
| Billed period                    | `invoices.period_month` and `invoice_lines.period_month` (1st of month)                                            | exists                                                             | the line's `period_month` = M                                                                                                                                      |
| Hotel of a line                  | `invoice_lines.hotel_id` (core id), `hotel_code`, `hotel_name`                                                     | exists                                                             | join key to the core contract                                                                                                                                      |
| Summary invoice (several hotels) | several lines per invoice, `UNIQUE (invoice_id, agreement_id)`                                                     | exists                                                             | per line its own hotel → its own salesperson                                                                                                                       |
| Base without VAT                 | `invoice_lines.amount` = `billed_rooms × unit_price` (exact, 2 decimals)                                           | exists; **no VAT anywhere** on issued invoices (doc 040 §7.4 open) | base = `amount` of the line (**O2**: confirm it stays the net base once VAT exists)                                                                                |
| Currency                         | `invoices.currency` (agreement version's currency)                                                                 | exists                                                             | v1 CZK only; another currency → flag, excluded (**O6**)                                                                                                            |
| Credit note / partial correction | **does not exist** (only received documents have `CREDIT_NOTE`, doc 039)                                           | missing                                                            | none; partial corrections are open (**O3**, doc 040 §7.6)                                                                                                          |
| Cancellation (storno)            | `finance.invoice_cancellations` (whole invoice, TEST) with `cancelled_at`                                          | exists                                                             | before approval: line excluded; after: negative correction in the next statement (**O4**)                                                                          |
| Late issued invoice              | `issued_at` after the statement's approval                                                                         | exists                                                             | a REGULAR item in the next open statement with its original M and rate (**O5**, was Q16)                                                                           |
| Termination of an agreement      | `agreement_versions.valid_from` / `valid_to`                                                                       | exists                                                             | no input to the commission: no issued line = no commission                                                                                                         |
| Pause                            | **does not exist** (no pause in Finance or the contract template)                                                  | missing                                                            | no line = no commission; whether paused months count to N stays open (**O7**, doc 068 Q7)                                                                          |
| Recipient for M                  | core `sales_hotel_attributions` (#193): latest `effective_from ≤ M`, then highest revision; `NULL` = Firemní hotel | exists (core)                                                      | only through the contract §4                                                                                                                                       |
| First paid month, k              | core `commission_start` (revision 1, never moves)                                                                  | exists (core)                                                      | k = months from it + 1; k < 1 → flag                                                                                                                               |
| Stored rate version              | core `sales_hotel_commission_terms` (snapshot of the attribution)                                                  | exists (core)                                                      | missing → flag "Chybí podmínky provize"                                                                                                                            |
| Salesperson identity             | core users (id, display name)                                                                                      | exists (core)                                                      | id + name snapshot in the statement                                                                                                                                |

Nothing above is assumed where the system has no field: VAT, credit notes, pauses and live invoice
kinds are **missing** and listed as open rules (§7).

## 3. Boundary (for approval)

| Unit        | Owns                                                                                                                                                                                        | Never                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Finance** | invoices and lines, the **closing**, the **calculation**, the **approved, immutable statement** with its items and **audit** (events), the recorded salesperson invoice and the payout plan | attribution, rates, identity; reading a core table                      |
| **Core**    | attribution, stored rate versions (bindings), identity and permissions                                                                                                                      | amounts, invoices, statements; calling Finance; reading a Finance table |
| **Web**     | Obchod → Provize pages; calls Finance's API for statements (as other Finance pages) and the core for the portfolio                                                                          | any calculation or rule of its own                                      |

Only explicit, authorised contracts (ADR 0039: service token + forwarded session, evaluated per
request). No new process: no scheduler, worker, queue or mail.

## 4. The contract Core → Finance (new, internal)

`POST /api/internal/v1/finance/commissions/attributions` (service token `finance`, forwarded
session; core route `@ServiceAccess('finance')`):

```
request:  { month: 'YYYY-MM', hotelIds: uuid[] (1–200, unique) }
response: { month, fingerprint, hotels: [
  { hotelId,
    attribution: null                                     // no attribution in force for M
      | { revision, effectiveFrom: 'YYYY-MM', commissionStart: 'YYYY-MM',
          recipient: null                                 // Firemní hotel – bez provize
            | { salespersonId, displayName },
          binding: null                                   // Chybí podmínky provize
            | { bindingId, termsVersion, initialRate: '20.00', initialMonths: 24, maintenanceRate: '5.00' } } } ] }
```

- The forwarded session must hold the Finance approval permission (**O8**); a salesperson's own
  view never needs this contract (they read only the approved statement, which has snapshots).
- The core computes "in force for M" with the same function as the portfolio
  (`attributionTimeline`), never Finance.
- `fingerprint` = SHA-256 of the canonical response (revisions, binding ids).
- ADR 0039 §4: 2 s timeout, one retry (read). Unavailable → Finance answers **503 and writes
  nothing**.

## 5. Finance model and the order of writes (proposal for approval)

Tables in the `finance` schema (append-only, ADR 0006; no FK to the core):

- `commission_statements`: `period_month`, `salesperson_id` + name snapshot, `currency`,
  `mode` (TEST | LIVE), `total`, `fingerprint`, `approved_at/by`, `request_id`.
  `UNIQUE (period_month, salesperson_id, currency, mode)`. Never updated or deleted.
- `commission_statement_items`: `kind` REGULAR | CORRECTION, source `(invoice_id, line_no)` FK to
  `invoice_lines`, service month, hotel snapshot, `base`, `attribution_revision`, `binding_id`,
  `terms_version`, `k`, `rate`, `amount`. **I1:** `UNIQUE (invoice_id, line_no) WHERE kind =
'REGULAR'`; a CORRECTION references its REGULAR item. Trigger: a LIVE statement never holds a
  line of a TEST invoice.
- `commission_statement_events`: APPROVED (with the insert), SALESPERSON_INVOICE_RECORDED
  (number, date, amount — doc 068 I3), PAYOUT_PLANNED (date). No PAID in this batch.

**Preview (no write):** `GET /api/finance/commissions/preview?month=` (approval permission) —
Finance reads its own lines of M, calls §4 once, computes per salesperson the items, the flags and
the fingerprint of **that salesperson's own sources only** (line ids, bases, attribution
revisions, binding ids, rates, amounts, flags) — approving one salesperson never makes another
stale.

**Approve one salesperson** `POST /api/finance/commissions/statements`
`{ requestId, month, salespersonId, currency, mode, fingerprint }`:

1. Outside any transaction: read the own lines of M, call §4 (timeout → 503, nothing written),
   compute; a different fingerprint than the admin saw → **409 STATEMENT_STALE**; any flag of
   this salesperson → **422 STATEMENT_FLAGGED**.
2. One Finance transaction: `operation_requests` (idempotency per `requestId`; a replay after a
   lost answer returns the same statement); advisory lock
   `commission:<month>:<salesperson>:<currency>:<mode>`; re-read the own lines and cancellations
   and compare the Finance part of the fingerprint; an existing statement → **409
   ALREADY_APPROVED** (the same one returned); insert statement, items, event APPROVED.
3. The approved amount never changes (DB: no UPDATE/DELETE). Anything found later (late invoice,
   cancellation, changed attribution) becomes an item of a later statement.

**Salesperson view** `GET /api/finance/commissions/mine?month=` (`sales:work` through the core
contract's current user): only the own approved statement — state and **one amount**; before
approval "Zpracovává se"; never a hotel's invoice number, payment, date or another person.

## 6. Transition

- Nothing to migrate: no statement exists anywhere; 1a/1b data stay in the core unchanged.
- The old payment-based rules are void (§1); the local preview of doc 068 §10 is not migrated.
- **DEV:** only `mode = TEST` from the existing synthetic TEST invoices through the approved test
  procedure; a TEST statement is labelled TEST everywhere and can never become LIVE.
- **Live:** impossible until live invoices exist (doc 040 §5 gate, §13) and **O1** is decided.
- Order of PRs after approval: (a) core contract §4 + tests; (b) Finance migration + preview
  (read only); (c) approve + salesperson view; (d) salesperson invoice + payout plan.

## 7. Open rules (smallest default proposed, nothing switched on)

| #   | Question                                      | Proposed default                                                       |
| --- | --------------------------------------------- | ---------------------------------------------------------------------- |
| O1  | The live invoice kind(s) a statement accepts  | none until live issuing exists; listed, never "anything but TEST"      |
| O2  | Base once VAT is introduced                   | the line's net amount without VAT                                      |
| O3  | Credit notes / partial corrections            | not supported; only a whole cancellation                               |
| O4  | Cancellation after approval                   | negative CORRECTION in the next statement, original M and rate         |
| O5  | Invoice for M issued after approval (was Q16) | REGULAR item in the next open statement, original M and rate           |
| O6  | Other currency                                | flag, excluded; CZK only                                               |
| O7  | Pauses and N (Q7)                             | no line = no commission; k counts calendar months                      |
| O8  | Approval permission                           | new `finance:commissions_manage`, ADMIN only (security administration) |
| O9  | Rounding (Q3)                                 | per line half-up to 0.01; total = sum of lines; accountant to confirm  |
| O10 | First incomplete month (Q17)                  | the admin's confirmed first paid month counts as k = 1                 |
| O11 | Late salesperson invoice (Q2b)                | the next payout plan (15th of the following month)                     |
| O12 | When M may be approved                        | from the 1st of M+1 (Europe/Prague); lines of M issued later go by O5  |

## 8. Isolated model and scenarios

`docs/prototypes/069-commission-closing.mjs` (pure functions, no database, nothing imported by
the application; fixtures shaped like the real Finance rows of §2 and the contract of §4) and
`node --test docs/prototypes/069-commission-closing.test.mjs`:

| Scenario                                                            | Covered                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Billed period, never the payment                                    | a paid and an unpaid line count the same; payment data are not an input |
| Summary invoice with two hotels → two salespeople                   | ✓                                                                       |
| Rate boundary k = 24 / 25 within one statement                      | ✓                                                                       |
| Missing attribution, missing terms, Firemní hotel, before the start | flags / excluded, only that salesperson blocked                         |
| Cancelled before approval; cancelled after approval                 | excluded; CORRECTION in the next statement                              |
| Invoice issued after approval                                       | REGULAR in the next statement, original month and rate                  |
| Double closing, concurrent approval, replay after a lost answer     | one statement; same result; ALREADY_APPROVED                            |
| Stale fingerprint (source changed)                                  | STATEMENT_STALE                                                         |
| Approved amount never silently changed                              | immutability + difference shown, never applied                          |
| Source contract down                                                | 503, nothing written                                                    |
| TEST line into a LIVE statement                                     | refused                                                                 |
| Role isolation                                                      | salesperson projection: own statement only, one amount, no invoice data |
