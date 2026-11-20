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
| Cancellation (storno)            | `finance.invoice_cancellations` (whole invoice, TEST) with `cancelled_at`                                          | exists                                                             | before approval: line excluded; after: a CORRECTION due by §5a, once per item (DB) (**O4**)                                                                        |
| Late issued invoice              | `issued_at` after the statement's approval                                                                         | exists                                                             | REGULAR item due by §5a: its own month, or after the salesperson's latest statement (**O5**)                                                                       |
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
- **Batches (re-review 3b0e594).** The limit stays 200 hotels per request; the history is not
  limited (O16). Finance sends one request per billed month involved and splits its hotels into
  sorted batches of ≤ 200 (201 hotels → 200 + 1). **All batches must answer** before anything is
  computed: one failed batch (also after its retry) → 503 for the whole preview or approval,
  never a partial statement. The preview's fingerprint covers the batch fingerprints. Requests per
  preview = Σ over billed months of ⌈hotels / 200⌉; with O16 unbounded this grows with the history
  — the proposal is to measure it on DEV TEST data before LIVE and only then decide a bound
  (e.g. corrections only for months after the latest attribution change the core reports).

## 5. Finance model and the order of writes (proposal for approval)

Tables in the `finance` schema (append-only, ADR 0006; no FK to the core):

- `commission_statements`: `period_month`, `salesperson_id` + name snapshot, `currency`,
  `mode` (TEST | LIVE), `previous_statement_id`, `opening_balance`, `total` (sum of items),
  `closing_balance`, `amount_to_invoice` (≥ 0), `carried_forward` (≤ 0), `fingerprint`,
  `sources_read_at`, `approved_at/by`, `request_id`. `UNIQUE (period_month, salesperson_id,
currency, mode)`; trigger: no statement at or before the salesperson's latest one (same
  currency and mode) and `previous_statement_id` = that latest one. Never updated or deleted.
- `commission_statement_items`: `kind` REGULAR | CORRECTION, `cause` (`REGULAR`, `CANCELLED`,
  `REATTRIBUTED:<revision>`), source `(invoice_id, line_no)` FK to `invoice_lines`,
  `salesperson_id` (= the statement's), service month, hotel snapshot, `base`,
  `attribution_revision`, `binding_id`, `terms_version`, `k`, `rate`, `amount`.
  **I1:** `UNIQUE (invoice_id, line_no, mode) WHERE kind = 'REGULAR'`; **one storno per original
  item:** `UNIQUE (invoice_id, line_no, mode, salesperson_id, cause)`. Trigger: a LIVE statement
  never holds a line of a TEST invoice.
- `commission_statement_events`: APPROVED (with the insert), SALESPERSON_INVOICE_RECORDED
  (number, date, amount — doc 068 I3), PAYOUT_PLANNED (date). No PAID in this batch.

### 5a. The due month — every item and flag has exactly one at a time

Each pending item has an **earliest month E**: a never-included line → its billed month; a
correction of a booked line → the month after the statement of the line's original REGULAR item
(fixed; another salesperson's approval never moves it). It is **due** in
`D = E`, unless the salesperson already has a statement at or after E (same currency, mode) — then
`D` = the month after their **latest** statement. `D` is computed from Finance's own data only.

- The preview of M shows, per salesperson, what is due in M. Anything due **before** M is listed to
  the admin (flag `EARLIER_PERIOD_OPEN` with the month, invoice and hotel) and blocks only that
  salesperson's M until that earlier month is approved. So statements of one salesperson are
  approved strictly in order, and no item can be in two months.
- **Late invoice without any statement of that salesperson (re-review 2):** E = its billed month
  M0, D = M0. The admin sees it in every later preview as unresolved for M0 and approves the
  salesperson's own M0 statement — no earlier or zero statement is needed. If the salesperson
  already has a statement after M0, D = the month after their latest one (O5).
- Lines without any attribution (`UNASSIGNED`) are listed in every preview ≥ their billed month
  until the core has an attribution; they never block another salesperson.

### 5b. Corrections of approved items

For every line already in an approved statement, the preview compares what the sources say now
(cancelled? recipient, binding, rate of the core answer for its billed month) with the approved
items of that line, per salesperson; a non-zero difference is a CORRECTION for that salesperson,
due by §5a, with the original service month.

- **Cancellation after approval (O4):** −amount for the salesperson of the original item, cause
  `CANCELLED`. The DB uniqueness above makes a second storno of the same item impossible, also
  from a faulty or concurrent computation.
- **A real later correction of the attribution (O15 — a proposal, owner to confirm):** the old recipient gets −amount, the new
  recipient +amount at **their** bound rate, cause `REATTRIBUTED:<revision>`; a Firemní hotel gets
  only the reversal. The approved statements stay as they are.
- A line whose current sources are incomplete (missing terms …) is flagged; nothing is reversed
  silently.

### 5c. The balance — never a negative amount to invoice

`closing = opening + total`. The salesperson is asked to invoice only `amount_to_invoice =
max(0, closing)`. A negative `closing` is **not** an invoice request: the statement says
"Nic k fakturaci" and carries `carried_forward = closing` as the `opening_balance` of their next
statement, where it is netted against new items (**O13 — a proposal, owner to confirm**). Ending the cooperation with a negative
balance (**O14 — a proposal, owner to confirm**) is never settled automatically: the balance stays visible to the admin as
"Nevypořádané saldo" until a later batch records a settlement event (write-off with a reason, or
repayment) — the owner chooses which.

### 5d. Approve one salesperson — the order

**Preview (no write):** `GET /api/finance/commissions/preview?month=` (approval permission) —
Finance reads its own lines and items, calls §4 once per billed month involved, and computes per
salesperson the items, flags, balance and the fingerprint of **that salesperson's own sources
only** (previous statement, opening balance, line ids, bases, attribution revisions, binding ids,
rates, amounts, flags) — approving one salesperson never makes another stale.

`POST /api/finance/commissions/statements`
`{ requestId, month, salespersonId, currency, mode, fingerprint }`:

0. **Permission** (O8) — 403 otherwise, also for a replay.
1. **Replay:** a stored operation with this `requestId` — the same actor and content → its stored
   result, **without calling the core** (also when the core is down or sources have changed since);
   another actor or content → **409 IDEMPOTENCY_CONFLICT**.
2. **Order (Finance only):** a statement of the salesperson for M → **409 ALREADY_APPROVED** (that
   one returned); a later one → **409 PERIOD_ORDER**.
3. **Outside any transaction:** read the core (§4; timeout → **503, nothing written**), compute;
   a different fingerprint → **409 STATEMENT_STALE**; any flag (incl. `EARLIER_PERIOD_OPEN`) →
   **422 STATEMENT_FLAGGED**; no item → 422.
4. **One Finance transaction** under the advisory lock `commission:<mode>:<salesperson>` (all
   months of one salesperson serialise): insert into `operation_requests` (a concurrent same
   `requestId` waits and returns the stored result); repeat step 2; re-read Finance's part
   (latest statement, the salesperson's items, cancellations of every line touched) — changed →
   **409 STATEMENT_STALE**; insert statement, items (I1 and the storno uniqueness enforced by the
   DB), event APPROVED.
5. The approved amount never changes (DB: no UPDATE/DELETE). Anything found later becomes an item
   of a later statement (§5a, §5b).

**Which attribution version counts:** the core answer read in step 3, whose fingerprint equals the
one the admin confirmed; each item stores its `attribution_revision` and `binding_id`, the
statement `sources_read_at`. A core change committed after that read — even before the Finance
commit — is not part of the statement; it is a later correction (§5b) in the next due month. A
new line issued between step 3 and the commit is not lost: its due month becomes the next one.

**Payout plan (C12, O11).** The first payout day is the 15th of the first month whose cut-off
(the 10th) the salesperson's invoice met, counted from its **actual receipt**, and never before
the 15th of M+1: received on the 10th → the 15th of that month; from the 11th → the 15th of the
next month, however many months late (July, received 18. 11. → 15. 12.; received 10. 1. → 15. 1., 11. 1. → 15. 2. across the year). A plan is never before the receipt. Only a positive
`amount_to_invoice` gets a plan.

**Salesperson view** `GET /api/finance/commissions/mine?month=` (`sales:work` through the core
contract's current user): only the own approved statement — state and **one amount** ("K
fakturaci" or "Nic k fakturaci" with the balance carried); before approval "Zpracovává se";
never a hotel's invoice number, payment, date or another person.

## 6. Transition

- Nothing to migrate: no statement exists anywhere; 1a/1b data stay in the core unchanged.
- The old payment-based rules are void (§1); the local preview of doc 068 §10 is not migrated.
- **DEV:** only `mode = TEST` from the existing synthetic TEST invoices through the approved test
  procedure; a TEST statement is labelled TEST everywhere and can never become LIVE.
- **Live:** impossible until live invoices exist (doc 040 §5 gate, §13) and **O1** is decided.
- Order of PRs after approval: (a) core contract §4 + tests; (b) Finance migration + preview
  (read only); (c) approve + salesperson view; (d) salesperson invoice + payout plan.

## 7. Open rules (smallest default proposed, nothing switched on)

| #   | Question                                      | Proposed default                                                                                  |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| O1  | The live invoice kind(s) a statement accepts  | none until live issuing exists; listed, never "anything but TEST"                                 |
| O2  | Base once VAT is introduced                   | the line's net amount without VAT                                                                 |
| O3  | Credit notes / partial corrections            | not supported; only a whole cancellation                                                          |
| O4  | Cancellation after approval                   | CORRECTION in the nearest admissible month (§5a), original M and rate                             |
| O5  | Invoice for M issued after approval (was Q16) | REGULAR item due by §5a, original M and rate                                                      |
| O6  | Other currency                                | flag, excluded; CZK only                                                                          |
| O7  | Pauses and N (Q7)                             | no line = no commission; k counts calendar months                                                 |
| O8  | Approval permission                           | new `finance:commissions_manage`, ADMIN only (security administration)                            |
| O9  | Rounding (Q3)                                 | per line half-up to 0.01; total = sum of lines; accountant to confirm                             |
| O10 | First incomplete month (Q17)                  | the admin's confirmed first paid month counts as k = 1                                            |
| O11 | Late salesperson invoice (Q2b)                | the first 15th whose 10th cut-off the actual receipt met (§5d)                                    |
| O12 | When M may be approved                        | from the 1st of M+1 (Europe/Prague); lines of M issued later go by O5                             |
| O13 | A negative balance                            | **proposal, owner to confirm:** carried and netted in the next statement; accountant to confirm   |
| O14 | Negative balance when the cooperation ends    | **proposal, owner to confirm:** shown as unsettled; write-off or repayment recorded by hand later |
| O15 | Attribution corrected after approval          | **proposal, owner to confirm:** reversal for the old, new item for the new recipient (§5b)        |
| O16 | How far back corrections look                 | **proposal, owner to confirm:** no limit in v1 (every booked line); revisit with the real volume  |

## 8. Isolated model and scenarios

`docs/prototypes/069-commission-closing.mjs` (pure functions, no database, nothing imported by
the application; fixtures shaped like the real Finance rows of §2 and the contract of §4) and
`node --test docs/prototypes/069-commission-closing.test.mjs`:

| Scenario                                                                 | Covered                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Billed period, never the payment                                         | a paid and an unpaid line count the same; payment data are not an input |
| Summary invoice with two hotels → two salespeople                        | ✓                                                                       |
| Rate boundary k = 24 / 25 within one statement                           | ✓                                                                       |
| Missing attribution, missing terms, Firemní hotel, before the start      | flags / excluded, only that salesperson blocked                         |
| Cancelled before approval; cancelled after approval                      | excluded; CORRECTION in the next statement                              |
| Storno never in an earlier open month; a later month blocked until it    | `EARLIER_PERIOD_OPEN`; negative result carried, netted next month       |
| Two months of one salesperson at once (both orders)                      | `PERIOD_ORDER` / `STATEMENT_STALE`; the late line due in the next month |
| The same storno a second time (faulty or concurrent computation)         | `CORRECTION_DUPLICATE` (DB uniqueness)                                  |
| Late invoice, no statement of that salesperson yet; unassigned lines     | shown in later previews; own month approvable; never skipped            |
| Invoice issued after approval                                            | REGULAR in the next statement, original month and rate                  |
| Double closing, concurrent approval, replay after a lost answer          | one statement; same result; ALREADY_APPROVED                            |
| Replay with the core down or changed sources; other actor; no permission | stored result without a core call; IDEMPOTENCY_CONFLICT; FORBIDDEN      |
| Attribution corrected in the core after the read / after approval        | statement keeps the read revision; reversal + new item next month       |
| Stale fingerprint (source changed)                                       | STATEMENT_STALE                                                         |
| Approved amount never silently changed                                   | immutability + difference shown, never applied                          |
| Source contract down                                                     | 503, nothing written                                                    |
| TEST line into a LIVE statement                                          | refused                                                                 |
| Role isolation                                                           | salesperson projection: own statement only, one amount, no invoice data |
