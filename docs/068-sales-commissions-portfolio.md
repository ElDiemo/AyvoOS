# 068 — Provize obchodníků: předání akvizice, model prvního PR, mapa testů

Status (2026-11-18):

- **PR 1a** (#192, terms) and **PR 1b** (#193, attribution and portfolio) are approved by the
  owner, merged and on DEV (§3.1–§3.3 as implemented; 1b: the effective-month order, a revision
  must change the recipient, the binding only in the attribution's transaction).
- **The Finance part** (calculation, statements, closing, payouts: §3.4–§3.8, §4 PR 2/3, §6 PR
  2/3 columns) is **superseded where it conflicts by doc 069 and the ADR 0046 addendum of
  2026-11-18**: the hotel's payment is never an input; a closed calendar month is computed from
  valid issued invoice lines by billed period; the admin approves in Obchod → Provize. Nothing of
  Finance is implemented.
- The local artefacts of the proposal phase (the preview `docs/previews/068-provize-nahled.html`
  and the calculation model `docs/prototypes/068-commission-calc.mjs`, §9–§10) stay on the local
  branch `docs/commissions-boundary`; the isolated model of the closing is now
  `docs/prototypes/069-commission-closing.mjs` (doc 069 §8).

Boundary: ADR 0046.

## 0. What is confirmed and what is open (for the technical review)

PR tags: **1a** = terms and admin (core), **1b** = attribution and portfolio (core), **2** =
Finance contract and read-only preview, **3** = Finance statement, closing and payout record.

Confirmed by the owner (2026-11-16):

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PR       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1  | Terms per salesperson: initial rate %, N whole months, maintenance rate % from month N+1. Examples 20/24/5 and 10/36/3.                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1a       |
| C2  | Only the admin manages terms, enforced by the API; the salesperson reads their own terms only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1a       |
| C3  | A newly attributed hotel takes the valid terms version (the history rule Q10 is the proposal around it).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1a, 1b   |
| C4  | At signing, the admin confirms the salesperson who won the hotel; the hotel counts in their portfolio with an **estimate**.                                                                                                                                                                                                                                                                                                                                                                                                                                    | 1b       |
| C5  | Month 1 of the rate = the first month the hotel pays under its contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1b       |
| C6  | After the invoice is issued: the actual commission, "Čeká na úhradu hotelu".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2        |
| C7  | ~~A confirmed payment in month X → the statement of month X~~ — **replaced in the proposal for review by C11** (owner 2026-11-17).                                                                                                                                                                                                                                                                                                                                                                                                                             | —        |
| C8  | The payout date only as confirmed by Finance; "Vyplaceno" only after the actual payout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 3        |
| C9  | One CZK statement ("Měsíční podklad") per salesperson × month and one salesperson invoice on its total; only the published complete statement is ready to invoice; a published statement is fixed (owner 2026-11-17).                                                                                                                                                                                                                                                                                                                                          | 3        |
| C10 | A salesperson sees only their own commission, its period and "V podkladu za …" or the neutral "Zatím v podkladu není" — never a hotel's invoice number, payment state, date or amount (Finance's authorised view; the salesperson API projections never send them). The own invoice number and state stay in the overview. The count of active hotels is separate from the statement; a late payment of a former hotel goes to the original salesperson at the original rate when the entitlement arises and the item was not included yet (owner 2026-11-17). | 1b, 2, 3 |
| C11 | **Proposal for review (owner 2026-11-17), replaces the "payment month":** a commission comes from a **valid issued hotel invoice for billed service** (without VAT) and belongs to **its billed period**. The hotel's payment is Finance's information outside the salesperson and never conditions it. An effective pause or termination ends new commissions from unbilled service; a billed part before it stays (§3.5).                                                                                                                                    | 2, 3     |
| C12 | **Monthly rhythm (owner 2026-11-17, confirmed):** from the **1st** the verified actual amount of the previous service month is published; by the **10th** the salesperson delivers one invoice; by the **15th** a timely received, checked invoice is paid out. Continuous validation before the closing; a statement with a conflict stays "Zpracovává se" with no amount to invoice. A late invoice: the next payment run with the original statement (**recommendation**).                                                                                  | 3        |

Open (none blocks PR 1a or 1b; §5):

| #                                | Question                                                                                                               | Blocks        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| Q7                               | Contractual pauses: do paused months count towards N?                                                                  | 3 (not 1a/1b) |
| Q2a                              | A partial payment — **no longer a commission question under C11** (only Finance's)                                     | —             |
| Q2b                              | A late salesperson invoice — **recommendation:** the next payment run, the original statement unchanged                | 3             |
| Q14                              | The payment date — **no longer conditions a commission under C11**; the payout days are C12                            | —             |
| Q16                              | A hotel invoice for a period issued after that period's statement is published                                         | 3             |
| Q17                              | A start in the middle of a month (the first incomplete month)                                                          | 3             |
| Q10                              | The history rule of terms (proposal)                                                                                   | 1b            |
| Q1b                              | The first charged month: the signing proves only the agreed start date (§8.3), so an explicit confirmation is proposed | 1b            |
| Q3, Q4, Q6, Q8, Q9, Q11–Q13, Q15 | Smaller rules, each with a proposal                                                                                    | 1b, 3         |

Two hotel situations the portfolio must handle from PR 1b on (both in the preview):

- **A contract linked with the hotel:** a signed revision of a draft with both a prospect and this
  hotel. It offers the prospect's owner as the prefill and the month of `start_on` as the
  commission start; the admin confirms both.
- **An existing hotel without an acquisition source:** no signed draft (every hotel today). The
  attribution is `MANUAL` with a reason, and the admin enters the commission start explicitly.
  Nothing is offered.

## 1. Where the acquisition really meets the hotel (verified on `origin/main` 690f769)

```
sales_prospects (owner_id, stage WON)          ← Obchod, doc 034. No hotel link (ADR 0031).
        │ prospect_id
contract_drafts (prospect_id?, hotel_id?)      ← contracts, doc 045. The ONLY prospect ↔ hotel link.
        │ draft_id + revision                     Hotel link checked against the hotel the draft names.
contract_signed_documents (signed_on)          ← After signing, the link never changes
        │                                         (trigger contract_drafts_signed_lock).
hotels (created_by = whoever typed it in)      ← customers, doc 028. Created by hand; not a sales fact.
        ┆ hotel_id (no FK across units)
finance.billing_agreements (hotel_id unique)   ← Finance, doc 040. Created by hand. contract_number =
        │                                         free text, not linked to SN-….
finance.invoice_lines (hotel_id, period_month, billed_rooms × unit_price = amount, no VAT)
        │ invoice_id                              One line per hotel agreement; kind TEST only.
finance.payment_allocations (per invoice)      ← doc 041. Exact VS or a manual allocation.
```

Findings:

1. **The supported handover point** is a **contract draft with both a prospect and a hotel and a
   signed original of one revision**. Only there do the acquisition, its owner at that time and
   the operational hotel meet, held by the database.
2. A hotel without such a draft has no acquisition source. That covers every existing hotel and
   hotels whose contract was signed outside the generator. Its attribution is a **manual
   decision** with a reason.
3. The hotel's `created_by` and a prospect's later owner are not sources (brief: "Autor karty
   hotelu sám o sobě připsání provize neurčuje").
4. Finance never sees the draft: `contract_number` is free text. The commission base therefore
   comes from the invoice line, which carries `hotel_id`, never from the contract.
5. One invoice may have several hotel lines of one customer (summary invoice). Payments are
   allocated per invoice. Doc 040 §13 plans one live invoice per agreement, but summary invoices
   are an open accountant question (doc 040 §7.7).

## 2. The first PRs — 1a "Podmínky provize", 1b "Přiřazení a portfolio" (core only)

Owner's clarification (2026-11-16): commission terms are set per salesperson in
**Obchod → Provize → Nastavení**. Attribution binds those terms to the hotel in the same
transaction, so the terms come first.

**PR 1a — Podmínky provize (terms)**

- Migration:
  - `sales_commission_terms` (§3.1);
  - the permission `sales:commission_terms_manage` in the catalogue and in `packages/types`,
    granted to ADMIN in the same migration (the role-matrix test).
- Module `apps/api/src/commissions`. API §4.1.
- Web:
  - **Obchod → Provize → Nastavení** (ADMIN): pick a salesperson, see their valid version and its
    history, and record a new version (initial rate %, N months, maintenance rate %, reason,
    confirmation). The page says "Platí pro nově přiřazené hotely".
  - **Moje podmínky** (`sales:work`): own terms, read-only.
- Tests: the PR 1a column of §6.

**PR 1b — Přiřazení a portfolio**

- Migration: `sales_hotel_attributions` (§3.2) and `sales_hotel_commission_terms` (§3.3).
- Module `commissions`, which imports `customers`, `sales` (ProspectContextService) and
  `contracts`. In `contracts`, one new exported read method, `signedAcquisitionSources(hotelId)`:
  signed drafts of this hotel with their prospect.
- API §4.2:
  - attribute or correct on the hotel card (the valid terms bound in the same transaction);
  - an explicit, future-only change of a hotel's terms;
  - the history and the candidates from signed drafts;
  - the portfolio for a month.
- Web:
  - a panel **"Obchodník (provize)"** on the hotel card, with the applied terms;
  - **Obchod → Provize** with the portfolio: hotels, attributed since, the source, the applied
    terms (or "Chybí podmínky provize"), the first commission month (§3.2), and the **estimated commission**
    from the signed contract × the bound terms, marked "Odhad" (owner 2026-11-16: shown from the
    signing). Actual amounts, payment states and payouts come from Finance in PR 2/3.
- Tests: the PR 1b column of §6.

**Out of scope** (later PRs, after ADR 0046 is accepted):

- the internal contract for Finance;
- the calculation, statements and closing;
- the salesperson's invoice and payouts.

**Size estimate:**

| PR  | Migration | API  | Types | Web  | Tests |
| --- | --------- | ---- | ----- | ---- | ----- |
| 1a  | ~90       | ~200 | ~50   | ~250 | ~300  |
| 1b  | ~170      | ~500 | ~80   | ~400 | ~550  |

## 3. Model for approval (core schema, all append-only)

### 3.1 `sales_commission_terms` — the terms versions of a salesperson (PR 1a)

| Column                                     | Type                                    | Rule                                                                                        |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                       | uuid v7                                 | PK                                                                                          |
| `salesperson_id`                           | uuid FK `users`                         | RESTRICT                                                                                    |
| `version`                                  | int                                     | 1, 2, … per salesperson; unique `(salesperson_id, version)`; the newest = **valid version** |
| `initial_rate`                             | numeric (no typmod)                     | CHECK 0 ≤ x ≤ 100 and `scale(x) ≤ 2` (refused, never rounded); 0.00 is explicit             |
| `initial_months`                           | int                                     | CHECK ≥ 1 (whole months). An upper bound is Q12.                                            |
| `maintenance_rate`                         | numeric (no typmod)                     | the same as `initial_rate`; applies from month N+1                                          |
| `reason`                                   | text                                    | required, non-blank                                                                         |
| `recorded_at`, `recorded_by`, `request_id` | timestamptz, uuid FK users, uuid unique |                                                                                             |

- `version` = max + 1, under the advisory lock `sales-terms:<salesperson_id>` + `expectedVersion`.
- The salesperson must be an active user with `sales:work`.
- A new version never touches hotels already bound (§3.3).

### 3.2 `sales_hotel_attributions` — who gets the commission for a hotel (PR 1b)

| Column                                     | Type                                    | Rule                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                       | uuid v7                                 | PK                                                                                                                                                                                                                                                                                                    |
| `hotel_id`                                 | uuid FK `hotels`                        | RESTRICT                                                                                                                                                                                                                                                                                              |
| `revision`                                 | int                                     | 1, 2, … per hotel, unique `(hotel_id, revision)`; the order of recording                                                                                                                                                                                                                              |
| `effective_from`                           | date                                    | CHECK = the 1st of a month; in force from that service month                                                                                                                                                                                                                                          |
| `salesperson_id`                           | uuid FK `users` NULL                    | NULL = **explicitly nobody** from that month (e.g. a house account); never "unknown"                                                                                                                                                                                                                  |
| `source`                                   | text                                    | `CONTRACT` \| `MANUAL` (CHECK)                                                                                                                                                                                                                                                                        |
| `contract_draft_id`, `contract_revision`   | uuid, int NULL                          | Exactly when `source = CONTRACT` (CHECK). Composite FK → `contract_signed_documents(draft_id, revision)`, so only a signed revision.                                                                                                                                                                  |
| `prospect_id`                              | uuid FK `sales_prospects` NULL          | The draft's prospect, when there is one                                                                                                                                                                                                                                                               |
| `prefilled_salesperson_id`                 | uuid FK `users` NULL                    | Who was offered (the prospect's owner at the time). Kept so that "confirmed as offered" and "changed by hand" stay distinguishable.                                                                                                                                                                   |
| `commission_start`                         | date                                    | The 1st of the first commission month, **always confirmed explicitly by the admin** (§8.3). Source `CONTRACT`: prefilled with the month of the signed revision's `start_on`. `MANUAL` (an existing hotel): entered. A trigger keeps it equal to revision 1's: a change of salesperson never moves it. |
| `contract_start_on`                        | date NULL                               | The signed revision's `start_on` as it was offered (exactly when `source = CONTRACT`, CHECK). A confirmed start in another month needs the reason to say why, so the difference stays visible.                                                                                                        |
| `reason`                                   | text                                    | Required, non-blank (CHECK)                                                                                                                                                                                                                                                                           |
| `recorded_at`, `recorded_by`, `request_id` | timestamptz, uuid FK users, uuid unique |                                                                                                                                                                                                                                                                                                       |

DB invariants:

- Triggers refuse every UPDATE, DELETE and TRUNCATE.
- `revision` = max + 1 for the hotel, checked by a trigger under the advisory lock
  `sales-attribution:<hotel_id>`.
- The `CONTRACT` source's draft must have `hotel_id` = this hotel. The service checks it under the
  draft's row lock. The DB trigger checks the same through the signed lock, which makes the
  draft's hotel immutable.

Who is attributed to hotel H for month M: the row of H with the largest `revision` among those
with `effective_from ≤ M`. This is a SQL view or function in the module, tested.

> **Owner check (Q6):** with this rule, a later revision with an earlier `effective_from` corrects
> the past (bitemporal, as in Finance's agreements). Closed statements are not rewritten (ADR 0046
> §3); they get a correction. If the owner wants attributions only forward in time, the rule is a
> CHECK: `effective_from ≥` the month of `recorded_at`.

### 3.3 `sales_hotel_commission_terms` — the terms applied to an attributed hotel (PR 1b)

| Column                                               | Type                                  | Rule                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                 | uuid v7                               | PK                                                                                                                                                           |
| `hotel_id`, `attribution_revision`                   | uuid, int                             | composite FK → `sales_hotel_attributions(hotel_id, revision)`; the binding belongs to that attribution and its salesperson                                   |
| `binding_no`                                         | int                                   | 1, 2, … per (hotel, attribution revision); unique                                                                                                            |
| `kind`                                               | text                                  | `ON_ATTRIBUTION` (written with the attribution) \| `EXPLICIT_CHANGE` (admin, later)                                                                          |
| `effective_from`                                     | date                                  | the 1st of a month. `ON_ATTRIBUTION` = the attribution's month. `EXPLICIT_CHANGE` = **after** the month of `recorded_at` (CHECK, Europe/Prague): future only |
| `terms_id`                                           | uuid FK `sales_commission_terms` NULL | the version the snapshot came from. It must be the same salesperson's (trigger). NULL with `EXPLICIT_CHANGE` = rates entered for this hotel only             |
| `initial_rate`, `initial_months`, `maintenance_rate` | as in §3.1                            | the **snapshot**: the rates used for this hotel, never re-read from the terms version                                                                        |
| `reason`, `recorded_at`, `recorded_by`, `request_id` |                                       | the reason is required for `EXPLICIT_CHANGE`                                                                                                                 |

How the rules work:

- **Rate for hotel H and service month M.**
  1. The attribution of M (§3.2) gives the salesperson.
  2. That attribution's binding with the largest `binding_no` among those with
     `effective_from ≤ M` gives the rates.
  3. `k` = the commission month number from the hotel's `commission_start` (§3.2, Q7):
     - `k ≤ initial_months` → `initial_rate`;
     - `k ≥ initial_months + 1` → `maintenance_rate`.
  4. With no binding (missing terms), the state is **"Chybí podmínky provize"**: no amount, and
     no statement item.
- **New attribution:** when the salesperson has a valid version, the service writes the
  `ON_ATTRIBUTION` binding from it **in the same transaction**. Otherwise it writes no binding, and
  the hotel shows the missing state.
- **A new terms version** applies to hotels attributed after it is recorded. Bound hotels are
  unchanged.
- **Explicit change:** `EXPLICIT_CHANGE` from a future month, with a reason. It takes the valid
  version or rates for this hotel. Past months are never touched.
- **Statements** (Finance, PR 3) keep the binding id and the snapshot of each item. A later binding
  can only lead to a correction in a later statement, never to a rewrite.

No other core table. Statements are Finance tables, proposed later.

### 3.4 The monthly statement and the states (owner, 2026-11-16 and 2026-11-17)

**The monthly statement ("Měsíční podklad"; owner 2026-11-17, explicit):**

- In one currency (v1: **CZK only**), there is **one statement per salesperson and period** (C11: the billed period)
  and **one salesperson invoice on its total**. A hotel is only an item in the statement's
  breakdown; a hotel's detail never asks the salesperson to invoice anything.
- An issued hotel invoice for period X puts its item into the statement of X **being prepared**
  (C11 proposal; earlier working rule: the hotel's payment). Only the
  **publication of the complete statement** opens the one action "Stáhnout podklad" in the
  overview. The downloaded file is the "Měsíční podklad": the total and the breakdown.
- A **published statement is fixed**. It is never extended, and no second statement or second
  salesperson invoice follows in the same month.
- **Open (Q16):** payments allocated at the end of the month or after the publication, and the
  timing of the payout against the closing. Nothing assumes that a salesperson invoices more than
  once a month; until decided, such an item is held, never added to a published statement.

States of the statement (what the salesperson's overview shows):

| State                  | When                                                    | "K fakturaci" | Action                                  |
| ---------------------- | ------------------------------------------------------- | ------------- | --------------------------------------- |
| Zatím bez podkladu     | No item in the month                                    | —             | none (wait)                             |
| Zpracovává se          | Items of the period issued, the statement not published | —             | none (wait)                             |
| Připraveno k fakturaci | The complete statement published                        | the total     | "Stáhnout podklad" (the one invoice)    |
| Faktura přijata        | The salesperson's one invoice on the total received     | —             | none; waits for the payout (known date) |
| Vyplaceno              | The payout recorded by Finance                          | —             | the date; "Zobrazit podklad" secondary  |

States of an item (a hotel × service month) — **Finance's authorised view**. The salesperson sees
only the last column (C10):

| State                  | When                                                                                                | Amount                                                | Salesperson sees                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Odhad                  | Signed contract, attribution confirmed, no invoice for the month yet                                | rooms × price of the signed revision × the bound rate | Zatím v podkladu není (the amount marked „odhad“) |
| Čeká na úhradu hotelu  | Finance's information only: the invoice is not fully paid. Under C11 it does not hold the item back | Actually calculated from the invoice line             | Zatím v podkladu není / V podkladu za X           |
| Hotel zaplatil         | Finance's information only: the hotel paid. Under C11 it changes nothing for the commission         | The same                                              | Zatím v podkladu není / V podkladu za X           |
| V podkladu za X        | The statement of the billed period X published (then invoiced, then paid out)                       | The same, frozen in the statement                     | V podkladu za X                                   |
| Chybí podmínky provize | No terms bound (§3.3)                                                                               | none, no statement item                               | Chybí podmínky provize                            |

### 3.5 The billed period (owner 2026-11-17 — proposal for the review of PR 2/3)

**Rule (replaces the working rule "the month of the hotel's payment" in this proposal):**

- A commission comes from a **valid issued hotel invoice** (issued, not cancelled, of a listed
  kind) for **billed service**, from its amount **without VAT**, and it belongs to the invoice's
  **billed period** (the line's service month).
- **When the hotel pays** is Finance's information outside the salesperson. It **never conditions**
  the commission and never moves it to another period.
- **One statement per salesperson and period** (C9): the statement of a period is made after that
  period's closing; the salesperson then issues one invoice on its total.
- **An effective pause or termination** ends new commissions from unbilled service. A part billed
  before it takes effect stays. Billing the unbilled part in advance and cancelling it later is a
  storno (below).
- **Storno:** a cancelled invoice yields no commission. Before the statement is published its item
  leaves the draft; after the publication the statement stays and a compensating correction
  follows once in the next statement (proposal).
- **Open:** an invoice for a period issued after that period's statement is
  published (Q16); whether paused months count towards N (Q7).

**The difference to the earlier working rule:**

| Case                                              | Earlier: the payment month     | Now (C11): the billed period             |
| ------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| First invoice 15. 7. for July service, paid 3. 9. | September statement            | **July** period, invoiced in August      |
| June invoice paid in July                         | July statement                 | June period                              |
| Invoice in July in advance for August             | the month it is paid           | **August** period                        |
| Unpaid or partly paid invoice                     | nothing until fully paid (Q2a) | counts once issued; payment is Finance's |
| The salesperson's view                            | waits for the hotel's payment  | the period and "V podkladu za …" only    |

**Example (synthetic):** a hotel of plan 20/24/5 starts in July 2027. Its first invoice, issued on 15. 7. for July service at 5 000.00 without VAT, gives 1 000.00 in the **July** period. The July
statement is made after the July closing and the salesperson invoices 1 000.00 in August; the
hotel's payment (whenever) changes nothing. **Variant:** an invoice issued on 20. 7. in advance for
August belongs to the **August** period (commission month 3 for a hotel that started in June), not
to July.

**Proposed hotel invoicing standard (not switched on):** a hotel is invoiced on the **1st day for
the current month**, due as the contract says. The first invoice of a hotel starting later may be
issued during the month (example above: 15. 7.).

**Monthly rhythm (C12, confirmed 2026-11-17):** from the 1st of the next month Finance publishes
the verified statement of the previous service month; the salesperson delivers one invoice by the
10th; a timely received and checked invoice is paid out by the 15th. A late invoice goes to the
next payment run, the original statement unchanged (recommendation, Q2b). **Still open:** a start
in the middle of a month (Q17, the hypothesis below). Nothing is switched on in running Finance.

Prototype: `docs/prototypes/068-commission-calc.mjs` closes a period from the issued lines of that
period; S3, S4, S6, S11–S16 cover it. The preview (§10) shows the billed period: the July
statement of Alena is "Zpracovává se" during July, the June one is in Finance's review.

### 3.6 Hand-checkable breakdown (test S15; base × rate, half-up to hundredths)

Plan A = 20 % for 24 months, then 5 %. H7 = a hotel of A starting on 15. 7. 2027, month 1 confirmed
as 07/2027 by the admin; H1 = a hotel of A since 01/2025; H3 = since 06/2027.

| #   | Case                                                        | Line (period, issued)                         | k      | Rate      | Base          | Commission                                                                   |
| --- | ----------------------------------------------------------- | --------------------------------------------- | ------ | --------- | ------------- | ---------------------------------------------------------------------------- |
| B1  | First part of a month (billing prorated 17/31 of 19 200.00) | H7 07/2027, 15. 7.                            | 1      | 20 %      | 10 529.03     | 2 105.81                                                                     |
| B2  | The standard: the 1st for the current month                 | H7 08/2027, 1. 8.                             | 2      | 20 %      | 19 200.00     | 3 840.00                                                                     |
| B3  | A pause in September (nothing billed)                       | H7 09/2027 none; 10/2027, 1. 10.              | 4      | 20 %      | 19 200.00     | 0 for 09; 3 840.00 for 10                                                    |
| B4  | Termination effective 1. 12.                                | H7 11/2027, 1. 11.; nothing later             | 5      | 20 %      | 19 200.00     | 3 840.00; nothing from 12                                                    |
| B5  | Late issue                                                  | H1 06/2027, 3. 7. (before the June statement) | 30     | 5 %       | 14 000.00     | 700.00 in June; a June line issued 10. 8. after the publication → held (Q16) |
| B6  | Storno after the publication                                | H3 07/2027, 1. 7., cancelled later            | 2      | 20 %      | 19 200.00     | 3 840.00, then −3 840.00 once in the next statement                          |
| B7  | The 24th and the 25th month                                 | H1 12/2026 and 01/2027                        | 24, 25 | 20 %, 5 % | 1 000.00 each | 200.00, 50.00                                                                |

**Set behaviour vs hypotheses (nothing of the hypotheses is switched on):**

- **First incomplete month (Q17, open).** Set: `k` counts calendar months from the start the admin
  confirmed, so B1's July is month 1 (with the prorated base billing issued), month 24 = 06/2029
  and month 25 = 07/2029. Hypothesis: an incomplete first month does not count, so month 24 would be
  07/2029. Not on.
- **Pauses (Q7, open).** Set: calendar months, so B3's October is month 4. Hypothesis: billed months
  only (October = month 3). Not on.

### 3.7 Finance's review before publishing (owner 2026-11-17)

Before a salesperson's statement of a period is published, Finance sees for each item:

- the **valid invoice line** (number, line, issued, not cancelled);
- the **service period**;
- the **base without VAT**;
- the **effective attribution** (salesperson, revision) for that period;
- the **rate** (`k`, binding) and the commission.

Rules:

- A **missing or conflicting input** (no terms, no base, the invoice no longer valid, a period that
  does not match the line, an attribution changed since the closing) **flags the item visibly**. The
  statement **of that salesperson** cannot be published until it is resolved at its source; other
  salespeople are not blocked.
- The publication is bound to the **fingerprint of the check**. When a source changed since the
  check, publishing is refused (`REVIEW_STALE`) and a re-check is required.
- A **second processing returns the same statement** (the same items and fingerprint): one item
  per source line, one statement per salesperson × period × currency.

- **Continuous validation before the closing:** the review runs during the month too; a statement
  with a conflict stays "Zpracovává se" without an amount to invoice, also after the 1st, until it
  is resolved and published.
- **The admin's one working place (owner 2026-11-17): Obchod → Provize → Přehled obchodníků.** The
  admin picks the month, opens a salesperson and, in the same detail, sees the source hotel
  invoices (Finance's check), **publishes the statement** ("Zveřejnit podklad": the salesperson may
  then invoice), **checks and assigns the received salesperson invoice** (its number and state
  "Faktura přijata") and **confirms the actual payout** by finding the matching movement — three
  distinct steps. The overview can **bulk-publish the checked statements**. Finance owns the data,
  operations and permissions; the page calls them through Finance's existing API (ADR 0039: the
  web calls Finance directly, the core never does), with no duplicate business rule in the UI and
  no mandatory "Finance → Provize" tab. In v1 the admin does it.
- **Admin → Obchod → Provize → Přehled obchodníků** (for the chosen service month): one row per
  salesperson — the name, the hotels in that period, the **fixed approved amount**, the state
  (Zpracovává se / čeká na fakturu / faktura přijata / vyplaceno) and the actions "Rozpis" and
  "Doklad"; the sum of the approved amounts below. After the invoice is received or paid out the
  admin still sees the approved amount; the salesperson no longer gets a call to invoice. No hotel
  receivable is a condition.
- **The salesperson's overview** names the month of the amount: "K fakturaci za červenec" next to
  "Hotely v tomto měsíci" of August.

Prototype: `review()` / `publish()` with `ITEMS_FLAGGED`, `REVIEW_STALE` and `PERIOD_NOT_CLOSED`,
`rhythm()`, `payoutRunFor()`; tests S16, S17. Preview:
Admin → "Kontrola podkladů" (§10). Running Finance is not changed.

### 3.8 Invariants before the Finance implementation (owner 2026-11-17)

| #   | Invariant                                                                                                                                                                                               | Prototype                                                                                                                                                                                       | Test |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| I1  | One valid accounting item → at most one regular statement item (corrections are separate, typed items)                                                                                                  | unique source line across closings and **within one input**                                                                                                                                     | S18  |
| I2  | An approved statement is immutable and arises only from a checked statement whose sources are current                                                                                                   | `publish()` only (no direct approval), fingerprint, `SOURCE_VERSION_CHANGED`, `publishedVsComputed()`                                                                                           | S19  |
| I3  | One salesperson invoice ↔ one statement; the acceptance checks the issuer, the document, the base without VAT and the currency; the payout amount is the payable amount                                 | `recordSalespersonInvoice()` (`INVOICE_ISSUER_MISMATCH`, `…_DOCUMENT_MISSING`, `…_BASE_MISMATCH`, `…_CURRENCY_MISMATCH`, `…_PAYABLE_MISMATCH`, `…_NUMBER_REUSED`, `SALESPERSON_INVOICE_EXISTS`) | S20  |
| I4  | "Vyplaceno" only with a booked outgoing movement of the same payee, amount, currency and reference — first as a manual assignment in Finance; an unclear, partial or duplicate movement changes nothing | `assignPayoutMovement()` returns `{ changed: false, reason }`                                                                                                                                   | S21  |

S18 found a defect of the prototype: the same invoice line twice in one closing's input made two
items; the closing now deduplicates within its input. Nothing here is active in Finance.

## 4. API (`/api/admin`, every route declares its rule)

### 4.1 PR 1a — terms

| Route                                      | Rule                            | Note                                                                                                                                  |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET sales/commission-terms/mine`          | `sales:work`                    | Own valid version and history, read-only                                                                                              |
| `GET sales/commission-terms?salesperson=…` | `sales:commission_terms_manage` | Any salesperson's versions                                                                                                            |
| `POST sales/commission-terms`              | `sales:commission_terms_manage` | `{ requestId, salespersonId, expectedVersion, initialRate '20.00', initialMonths 24, maintenanceRate '5.00', reason, confirm: true }` |

- A SALES account gets `403` on the POST and on the list of others.
- There is no PUT, PATCH or DELETE.
- Errors: `TERMS_RATE_INVALID` (outside 0–100 or more than 2 decimals), `TERMS_MONTHS_INVALID`,
  `SALESPERSON_NOT_ELIGIBLE`, `409 CONCURRENT_CHANGE`.

### 4.2 PR 1b — attribution and portfolio

| Route                                               | Rule                                                       | Note                                                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET hotels/:code/sales-attribution`                | `sales:manage` + `hotels:read`                             | The current attribution, the full revision history and the candidates from signed drafts                                                                                                                                           |
| `POST hotels/:code/sales-attribution`               | `sales:manage` + `hotels:read`                             | `{ requestId, expectedRevision, salespersonId \| null, effectiveFrom 'YYYY-MM', source, contractDraftCode?, contractRevision?, commissionStart 'YYYY-MM' (revision 1 only), confirmCommissionStart: true, reason, confirm: true }` |
| `GET sales/portfolio?month=YYYY-MM[&salesperson=…]` | `sales:work` (own); `salesperson` only with `sales:manage` | The hotels attributed for that month with their applied terms or the missing state; a manager gets the totals per salesperson                                                                                                      |
| `POST hotels/:code/sales-attribution/terms`         | `sales:commission_terms_manage` + `hotels:read`            | Explicit change: `{ requestId, expectedBinding, effectiveFrom (future month), fromValidVersion: true \| rates…, reason, confirm: true }` → `EFFECTIVE_FROM_NOT_FUTURE` otherwise                                                   |

Errors:

| Code                        | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `404`                       | Out of scope                                             |
| `409 CONCURRENT_CHANGE`     | A stale `expectedRevision`                               |
| `SALESPERSON_NOT_ELIGIBLE`  | Not active, or no `sales:work`                           |
| `CONTRACT_NOT_SIGNED`       | The draft's revision has no signed original              |
| `CONTRACT_OTHER_HOTEL`      | The signed draft belongs to another hotel                |
| `EFFECTIVE_FROM_INVALID`    | Not a month                                              |
| `EFFECTIVE_FROM_NOT_FUTURE` | An explicit terms change for the current or a past month |

**Projection for a salesperson (Q4):** code, name and city of the hotel; since when; the source
(`SN-…` + revision; the prospect `AKV-…` if it is in their scope); the estimated base. They get
nothing else from the hotel register: no contact, address or orders.

**Owner 2026-11-17 (C10):** the salesperson's projections (portfolio, breakdown, export; PR 1b and
the Finance read of PR 2/3) carry only the own commission — base, rate, `k`, the amount (an
estimate marked) — the service month and the statement month ("V podkladu za …") or the neutral
"Zatím v podkladu není". They **never send** a hotel's invoice number, payment state, payment date
or amount: those are Finance's authorised view. The overview keeps the salesperson's own invoice
number and its state. "Hotely v tomto měsíci" counts the active hotels (attributed for the month,
past the start) and is separate from the statement.

## 5. Open questions for the owner (nothing below is switched on)

| #   | Question                                                                                                               | Proposal                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Start of the commission period                                                                                         | **Decided (owner 2026-11-16):** the first month the hotel pays from under its contract; an existing hotel gets an explicit start. Q1a: a `start_on` in mid-month counts its month as month 1, unless the owner decides otherwise.                                                                                                                  |
| Q1b | Does the signing prove the first charged month?                                                                        | **No** (§8.3). Proposal: the month of `start_on` is only the prefill; the admin confirms the commission start explicitly at attribution, and PR 2 shows a warning when Finance's first invoice line has another month. Nothing is changed automatically.                                                                                           |
| Q2  | When a commission is paid out                                                                                          | **Decided (owner 2026-11-16):** the estimate at signing, the actual amount after the invoice ("Čeká na úhradu hotelu"), and the payout in the **calendar month of the confirmed payment**, never moved later by a closing. "Uhrazeno" only after the actual payout.                                                                                |
| Q2a | Partial payment of a hotel invoice (also a summary invoice)                                                            | **Superseded for commissions by C11 (proposal):** the issued invoice counts, not its payment. Partial payments remain Finance's own matter.                                                                                                                                                                                                        |
| Q2b | The salesperson's invoice delivered after the 10th                                                                     | **Recommendation (owner 2026-11-17, not decided):** paid in the next payment run (by the 15th of the following month); the published statement stays unchanged.                                                                                                                                                                                    |
| Q3  | Rounding of a line                                                                                                     | Per line, to 2 decimals, half-up; the total is the sum of the rounded lines. Accountant to confirm.                                                                                                                                                                                                                                                |
| Q4  | What a salesperson sees of an attributed hotel without `hotels:read`                                                   | Only the projection in §4                                                                                                                                                                                                                                                                                                                          |
| Q5  | Who attributes                                                                                                         | `sales:manage` + `hotels:read` (today ADMIN). Terms: `sales:commission_terms_manage`, ADMIN only (confirmed)                                                                                                                                                                                                                                       |
| Q6  | Can an attribution be corrected retroactively?                                                                         | Yes, bitemporal (§3); closed statements get a correction                                                                                                                                                                                                                                                                                           |
| Q7  | **Contractual pauses:** "24 commission months" = calendar months from the start, or months actually billed?            | **Open.** The contract and Finance have no pause today (an agreement has only `valid_from`/`valid_to`; the template's §5 is a gap). Until decided, `k` counts calendar months from the start (the prototype), and nothing for a paused month is paid because nothing is invoiced. It changes only `k` after a pause, i.e. PR 3, not the portfolio. |
| Q8  | A contract that ended and a new contract later: does the period start again?                                           | No: the hotel's start is kept. To confirm.                                                                                                                                                                                                                                                                                                         |
| Q9  | Who is "vedoucí"?                                                                                                      | `sales:manage` (today ADMIN). No sales-lead role (doc 034 §7).                                                                                                                                                                                                                                                                                     |
| Q10 | History rule of terms (§3.3)                                                                                           | A new hotel takes the valid version; a new version only for new hotels; an existing hotel only explicitly and for the future; approved statements never rewritten. **For review.**                                                                                                                                                                 |
| Q11 | A hotel attributed while terms were missing: when terms come, from which month?                                        | Only an explicit admin binding. Proposal: allowed from the attribution's month as long as no statement exists for those months (nothing was ever paid for them); otherwise only for the future.                                                                                                                                                    |
| Q12 | An upper bound of N and of the rates                                                                                   | None invented: rates 0–100 %, N ≥ 1. To confirm.                                                                                                                                                                                                                                                                                                   |
| Q13 | A hotel moved to another salesperson: does `k` keep counting from the hotel's start?                                   | Yes (brief: a change of salesperson never moves the start). The new salesperson's terms then apply to the hotel's current `k`. To confirm.                                                                                                                                                                                                         |
| Q14 | "The month of the confirmed payment"                                                                                   | **Superseded by C11 (proposal):** the billed period decides, not a payment date. The payout days are decided (C12).                                                                                                                                                                                                                                |
| Q15 | May an admin record terms or an attribution for themselves?                                                            | Proposal: yes (the owner may also sell), with the audit trail; no separate approval. To confirm.                                                                                                                                                                                                                                                   |
| Q16 | A hotel invoice for a period issued after that period's statement was published; the payout timing against the closing | **Open.** One statement and one salesperson invoice per period are confirmed; a published statement is fixed. Until decided, such a line is held (never a second statement or invoice for the period).                                                                                                                                             |
| Q17 | A start in the middle of a month: does the incomplete first month count as commission month 1?                         | **Open.** Set in the proposal: calendar months from the start the admin confirms (§3.6 B1); the hypothesis "does not count" is not on. (The days of the rhythm are decided: C12.)                                                                                                                                                                  |

## 6. Test map

`e2e` = `apps/api/test/*.e2e.test.ts` on a real DB as `ayvo_core`. `pw` = Playwright. `unit` =
Vitest.

| Scenario (brief "Ověření")                                               | PR 1a/1b (core)                                                                                                                                                     | PR 2 (contract + Finance preview)                                                | PR 3 (closing)                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Two salespeople and a manager: each sees only their own lines and totals | e2e `commissions-portfolio`: A and B, `sales:work` only. 404 on another's hotel; the list, count and `?salesperson=` are refused. pw: own rows only                 | e2e Finance: the lookup with B's session returns only B's lines                  | the statement detail and CSV/PDF of another person: 404                                                    |
| The manager sees the overview in the allowed scope                       | e2e: `sales:manage` gets the totals per salesperson                                                                                                                 | Finance overview per salesperson                                                 | —                                                                                                          |
| A summary invoice with two hotels → two salespeople                      | —                                                                                                                                                                   | unit + e2e Finance: each line goes to its hotel's salesperson                    | e2e: a partially paid summary invoice stays "Čeká na úhradu hotelu" (Q2a open)                             |
| Acceptance: signed earlier, pays from June, June invoice paid in July    | 1b e2e: `start_on` 2027-06-01 → `commission_start` 6/2027 = month 1; a signing in April changes nothing; the estimate is shown at once                              | e2e: the June line → "Čeká na úhradu hotelu" with the actual amount              | e2e: payment booked in July → statement 7, planned payout 7 (never 8), also when the closing runs on 1 Aug |
| Payout date and "Uhrazeno"                                               | —                                                                                                                                                                   | —                                                                                | e2e: no confirmed run → "nepotvrzeno"; "Uhrazeno" only after the recorded payout                           |
| The start never moves                                                    | 1b e2e: a change of salesperson keeps `commission_start` (trigger refuses another value)                                                                            | —                                                                                | —                                                                                                          |
| Two different terms (20 % / 24 / 5 % and 10 % / 36 / 3 %)                | 1a e2e: two salespeople, a version each; each reads only their own. 1b e2e: their hotels bind the right snapshot                                                    | unit: the same base gives 20 % vs 10 %                                           | e2e: one statement per salesperson with the item's snapshot                                                |
| Boundaries 24/25 (plan A) and 36/37 (plan B)                             | unit (pure function `rateFor(k, binding)`): k=24 → initial, k=25 → maintenance; k=36 → initial, k=37 → maintenance; k=1; N=1                                        | e2e: the lines of months 24/25 and 36/37 carry the right rate; exact `Decimal`   | e2e: the boundary across two closings                                                                      |
| A salesperson cannot edit terms                                          | 1a e2e as a real SALES session (`auth: 'real'`): POST → 403, GET of others → 403, own GET → 200; no PUT/PATCH/DELETE route (`identity.e2e`); pw: no form, read-only | —                                                                                | —                                                                                                          |
| Terms history is kept                                                    | 1a e2e: version 2 does not change version 1; the DB refuses UPDATE/DELETE/TRUNCATE (`withPrivileged`); a stale `expectedVersion` → 409; a replay → the same result  | —                                                                                | —                                                                                                          |
| A new version applies only to new hotels                                 | 1b e2e: hotel X bound to v1; v2 recorded; hotel Y attributed → v2; X still v1                                                                                       | —                                                                                | e2e: an approved statement keeps v1 after v2 and after an explicit change                                  |
| Explicit change only for the future                                      | 1b e2e: the current or a past month → `EFFECTIVE_FROM_NOT_FUTURE` (and a DB CHECK); next month → OK; months before it keep the old snapshot                         | —                                                                                | —                                                                                                          |
| Missing terms                                                            | 1b e2e: attribution without terms → no binding, the portfolio says "Chybí podmínky provize", no amount                                                              | e2e: the lookup `terms: null`; the preview shows the state                       | e2e: no statement item is created, and the closing names the hotel                                         |
| Invalid values                                                           | 1a e2e: 100.01, -1, 20.005, N=0, N=1.5 → refused (API and DB), never rounded; 0.00 accepted                                                                         | —                                                                                | —                                                                                                          |
| Late payment                                                             | —                                                                                                                                                                   | e2e: the item "Čeká na úhradu hotelu"                                            | e2e: the payout of the payment's month, original service month and rate                                    |
| A change of rooms or price                                               | —                                                                                                                                                                   | e2e: the base follows the line's `billed_rooms × unit_price`, never the contract | —                                                                                                          |
| End of contract                                                          | e2e: the attribution stays; the portfolio shows "bez fakturace"                                                                                                     | no lines → no items                                                              | —                                                                                                          |
| Change of salesperson without rewriting history                          | e2e: revision 2 from a month; month M-1 → A, M → B; the DB refuses UPDATE/DELETE/TRUNCATE (`withPrivileged` for the negative test)                                  | —                                                                                | e2e: a correction after a closed month (Q6)                                                                |
| Concurrent attribution                                                   | e2e: two POSTs with one `expectedRevision` → one 201, one 409; a replay of the same `requestId` → the same result                                                   | —                                                                                | —                                                                                                          |
| Prefill from a signed draft                                              | e2e: the candidate = the prospect owner; an unsigned or other-hotel draft is refused; a changed prospect owner never moves an attribution                           | —                                                                                | —                                                                                                          |
| Ineligible salesperson                                                   | e2e: deactivated, or without `sales:work` → `SALESPERSON_NOT_ELIGIBLE`                                                                                              | —                                                                                | —                                                                                                          |
| Closing repeated and concurrent                                          | —                                                                                                                                                                   | —                                                                                | e2e: two parallel closings → one statement; each line counted once (unique)                                |
| Finance or core unavailable                                              | pw: the portfolio works and the panel says "Finance je nedostupné"                                                                                                  | e2e: core down → Finance 503; lookup timeout → 503 and nothing written           | e2e: an interrupted closing, then a repeat → a truthful state                                              |
| A finished statement, the salesperson's invoice, the payment             | —                                                                                                                                                                   | —                                                                                | e2e: the states; the received document linked once                                                         |
| TEST data only in isolation                                              | —                                                                                                                                                                   | e2e: with `APP_ENV=production`, TEST lines are ignored (refused)                 | the same                                                                                                   |
| CZK only; currencies are never mixed                                     | unit: a total per currency in the estimate                                                                                                                          | unit: totals per currency                                                        | e2e: one statement per currency                                                                            |
| Every route declares its rule                                            | `identity.e2e.test.ts` (existing)                                                                                                                                   | the same                                                                         | the same                                                                                                   |

## 7. Order of work

1. **This document + ADR 0046:** owner review, then the independent review.
2. **PR 1a**, then **PR 1b**, after the owner approves §3.1–§3.3.
3. **PR 2:** the internal contract (attribution, start + terms snapshot), and a read-only Finance
   preview. Its model is proposed first, after ADR 0046 is accepted.
4. **PR 3:** the monthly statement by billed period (C11, proposal), statement items (unique per source line),
   corrections and exports. It is not enabled while Q2a, Q2b, Q3, Q7 and Q14 are open.

## 8. Technical checks for the review (on `origin/main` 690f769)

### 8.1 ADMIN only, also against a custom role

The risk: an ADMIN composes a custom role ("vlastní role") with `sales:commission_terms_manage`
and gives it to a salesperson, who could then edit their own terms.

Findings and the enforcement proposed for PR 1a:

- The catalogue has a flag `permissions.security_admin`. The trigger `role_permissions_guard`
  (migration `20261012120100_sites_and_custom_roles`) refuses an INSERT of such a permission into
  any non-system role. `RolesService.assertAssignable` refuses it with
  `SECURITY_PERMISSION_RESERVED`, and the role editor shows it disabled ("vyhrazeno").
- System roles change only inside a catalogue migration (the same trigger), so SALES can never get
  it at runtime.
- Precedent: `identity:portal_grants_manage` is ADMIN-only by the same flag (migration
  `20261113090100_portal_grants`).
- **PR 1a therefore inserts the permission with `security_admin = true`, grants it to ADMIN only,
  and adds it to `SECURITY_ADMIN_PERMISSIONS`** (the catalogue test in `identity.e2e` compares the
  two).
- The cost: the flag means "ADMIN only" here, not security in the narrow sense. A separate flag
  `admin_only` would need a change of the trigger, the role service and the editor; not proposed.
- The salesperson routes take the salesperson **only from the session** (`/mine`), never from the
  request. The routes for others require the permission. There is no PUT, PATCH or DELETE.
- Tests (prototype, §11): a custom role with the permission → 422 `SECURITY_PERMISSION_RESERVED`
  and the DB trigger refuses a direct INSERT; a real SALES session → 403 on POST and on the list of
  others, 200 on `/mine`; a SALES user who also holds a custom role with `sales:manage` still gets 403.

### 8.2 The old core after the additive change (rollback)

The deployment runs the migration first. A rollback leaves the new schema under the old core.

- **Permissions:** the old API drops unknown codes when it loads a session
  (`access.service.ts`, `filter(isPermissionCode)`), and so do the role service and the web
  (`reportedPermissionsSchema`). `test/permissions-forward-compat.e2e.test.ts` proves it for a code
  from the future. The new permission then grants nothing in the old version.
- **Tables:** the new tables are only read and written by the new module. They have FKs **to**
  `users`, `hotels` and `contract_signed_documents` (RESTRICT), and no trigger, column or
  constraint is added to an existing table. Users and hotels are deactivated, never deleted, and
  signed documents are append-only, so RESTRICT never blocks the old code.
- **Finance** is untouched in PR 1a/1b. The internal contract of PR 2 is a new route under `v1`.
  An older Finance never calls it, and an older core answers 404 to a newer Finance, which shows
  "nedostupné", never a guess.
- **The rollback is data-preserving:** the tables stay, nobody reads them, and a later redeploy
  continues from them.
- What is **not** compatible: the catalogue test (`identity.e2e`) of the old code against the new
  database. That is a test of the code's own catalogue, not a runtime path.

### 8.3 Does the signing prove the first charged month?

No. What is signed and stored:

- The revision's `startOn` is printed as "Začátek: <date>" (template `cs-b2b-1`, §3). It is the
  agreed **start of the service**, not "the first charged month".
- §5 of the template ("Doba trvání, ukončení a další ujednání") is a gap filled outside the
  generator. A free first month, a trial or a pause may be agreed there or on paper.
- The signed original is a stored PDF; its content is not read by the system.
- `start_on` may be any day. Finance bills whole months from the 1st (`agreement_versions`), and
  prorating is an open question (CLAUDE.md).
- The billing agreement in Finance is created by hand, with no link to the draft
  (`contract_number` is free text), so the first invoice line may come in another month.

The proposal (Q1b, in the model §3.2 and the API §4.2):

- The month of `start_on` is offered; the admin confirms the commission start explicitly
  (`confirmCommissionStart: true`). A different month needs a reason, and `contract_start_on` keeps
  what was offered.
- PR 2 shows a warning in the Finance preview when the hotel's first invoice line is in another
  month than `commission_start`. Nothing changes automatically.

### 8.4 The ADR's assumption about live invoices, against the code

ADR 0046 says that only TEST invoices exist and PROD has nothing to calculate. Verified:

- `finance.invoices.kind` has `CHECK ("kind" = 'TEST')` (migration `20261101100000_test_invoices`).
- `InvoicesService.issueTest` and the monthly run refuse with `TEST_INVOICES_DISABLED` when
  `APP_ENV=production`; the issuability flag is false there.
- Simulated payments exist only outside production (`PaymentsService.simulationAvailable`).
- Invoice lines carry `hotel_id`, `period_month`, `billed_rooms`, `unit_price` and `amount`, and are
  unique per (invoice, agreement). Payments are allocated per invoice, with the bank's `booked_on`
  on the payment (Q14).
- A cancellation is its own row (`invoice_cancellations`); the invoice never changes.

The impact:

- PR 1a and 1b (terms, attribution, portfolio and estimate) are useful on PROD at once: they need
  no invoice.
- PR 2 and PR 3 can be proven only on DEV with TEST data until live invoicing is approved (doc 040
  §13). Then the statement must accept a **listed** invoice kind, never "anything that is not
  TEST": a new kind must be added to that list on purpose.
- When live invoicing comes as "one tax document per agreement", the summary-invoice case (S4 in
  §9) may disappear on PROD; the model keeps it, because the TEST run already has it.

## 9. Isolated scenarios of the calculation and the closing

> Superseded by doc 069 §8 (the model of the closing without payments). Kept for history.

`docs/prototypes/068-commission-calc.mjs` is a model of the rules in pure functions (no
database, no Finance, nothing imported by the application). `node --test
docs/prototypes/068-commission-calc.test.mjs` runs the scenarios. Amounts are exact (integers in
hundredths), and rounding of a line follows the Q3 proposal (half-up to 2 decimals), marked as
a proposal.

| #   | Scenario                                                                                                             | What is proven                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Two salespeople, 20/24/5 and 10/36/3, the same base                                                                  | 20 % vs 10 %; each statement has only its own items                                                                                                                                                                          |
| S2  | Boundaries 24/25 (A) and 36/37 (B)                                                                                   | k=24 → 20 %, k=25 → 5 %; k=36 → 10 %, k=37 → 3 %                                                                                                                                                                             |
| S3  | The first hotel invoice on 15 July for July service (C11); variant: issued in July in advance for August             | July → the July period, one statement after the July closing, the salesperson invoices in August; the advance invoice → the August period (k 3), not July; the payment never conditions it                                   |
| S4  | A summary invoice with two hotels of two salespeople                                                                 | Each line to its hotel's salesperson; a partial or missing payment changes nothing (C11)                                                                                                                                     |
| S5  | Two closing runs of the same month                                                                                   | The second adds nothing; each source line is in at most one statement (unique key)                                                                                                                                           |
| S6  | The January invoice paid in September                                                                                | Stays in January with its `k` and rate; a later closing adds nothing                                                                                                                                                         |
| S7  | The core contract unavailable                                                                                        | The closing refuses (`CORE_UNAVAILABLE`) and writes nothing; a repeat later succeeds                                                                                                                                         |
| S8  | An approved statement and a later change (terms v2, an explicit change, a change of salesperson)                     | The approved statement is identical; the change appears only as a correction in a later statement                                                                                                                            |
| S9  | Missing terms                                                                                                        | No item; the closing names the hotel                                                                                                                                                                                         |
| S10 | A changed attribution between the preview and the approval                                                           | `ATTRIBUTION_STALE`                                                                                                                                                                                                          |
| S11 | Three hotels of one salesperson invoiced for the same period (owner 2026-11-17)                                      | One statement, one total, three lines, one salesperson invoice on the total (a second or a different amount refused); a line of that period issued after the publication is held (Q16), the statement unchanged; v1 CZK only |
| S12 | A former hotel: its May invoice (issued in May, paid in July after it left the salesperson)                          | In the May statement of the original salesperson at May's rate and `k`, once; the payment adds nothing; the count of active hotels unchanged                                                                                 |
| S13 | A cancelled invoice (storno)                                                                                         | Before the publication: the item leaves the draft. After it: the published statement stays, a compensating correction (−) follows once in the next statement (proposal)                                                      |
| S14 | An effective termination on 1. 9. (August billed in advance in July, September billed in advance and then cancelled) | August stays; nothing from September on                                                                                                                                                                                      |
| S15 | The hand-checkable breakdown B1–B7 (§3.6)                                                                            | Exactly the numbers of the table                                                                                                                                                                                             |
| S16 | Finance's review: no terms for one salesperson, an attribution changed after the closing                             | Only that salesperson is blocked; `ITEMS_FLAGGED`, then `REVIEW_STALE` until re-checked; a second processing returns the same statement and fingerprint                                                                      |
| S17 | The rhythm 31. 7. → 1. 8. / 10. 8. / 15. 8., plan 20 % unchanged; a late invoice; a conflict                         | Not published on 31. 7. (`PERIOD_NOT_CLOSED`); 1. 8. 3 840.00 at 20 %; invoice on 10. 8. → payout by 15. 8.; invoice on 12. 8. → run of 15. 9. (recommendation); a conflict → no statement to publish                        |
| S18 | I1: repeated closings, a duplicated input, another period, a storno                                                  | One regular item per source line; the storno a separate correction                                                                                                                                                           |
| S19 | I2: a newer invoice version after the check; a direct approval                                                       | Refused (`ITEMS_FLAGGED`; no `approve` export); published amount fixed, the difference shown                                                                                                                                 |
| S20 | I3: wrong issuer, no document, other currency, base ≠ total, payable ≠ net + VAT, a reused number, a second invoice  | Each refused; a VAT payer's payable amount accepted with the base without VAT                                                                                                                                                |
| S21 | I4: partial, other amount, currency, reference, payee, not booked, incoming, duplicate, no invoice                   | No change, with the reason; the exact movement → "Vyplaceno"                                                                                                                                                                 |

## 10. The preview — how to open it

> Local branch `docs/commissions-boundary` only; its payment states are superseded (doc 069).

1. Open `docs/previews/068-provize-nahled.html` in a browser (a file, no server; on this server:
   `python3 -m http.server -d docs/previews 8768`, then `http://127.0.0.1:8768/068-provize-nahled.html`
   through an SSH tunnel).
2. Pick a person at the top ("Zobrazit jako"): two salespeople with different terms, a salesperson
   without terms, a new salesperson with no hotels (the empty state), and the admin.
3. Salesperson (owner 2026-11-17, one simple page): Přehled opens on the current month with three
   facts only — "Hotely v tomto měsíci", "K fakturaci" (an amount only when the statement is ready)
   and "Stav podkladu" (Připraveno, Zpracovává se, Zatím bez podkladu, Uhrazeno) — the action
   "Stáhnout podklad" (a synthetic CSV) when the statement is ready, and the payout date only as a
   quiet detail when known. The hotels (20 for Alena in 07/2027) open only after a click on the
   count or "Zobrazit hotely": alphabetical, search by name or city, a state filter, "x z y
   hotelů", one row = hotel, commission, state. A row opens the hotel's breakdown (rooms × price,
   rate, invoice, payment, payout; the service month vs the payout month where it differs, with
   the June → July case of Vltava Park); "Zpět na přehled" keeps the search, the filter and the
   focus. Moje podmínky stays read-only.
4. Admin: Nastavení (choose a salesperson, the history, a new version, a future change of one
   hotel), and the hotel card (a contract-linked hotel and one without an acquisition source).

The demo calendar is 20. 7. 2027 (open month 07/2027), so the acceptance case (signed in April,
pays from June, the June invoice paid in July → payout July) and the boundaries 24/25 (Hotel U
Mlýna) and 36/37 (Hotel Kamenný Most) fall into the months shown. A view opens directly with
`#<person>/<tab>`, e.g. `#alena/rozpis`, `#cyril/prehled`, `#dana/prehled`, `#admin/nastaveni`,
`#admin/karta`.

Everything is synthetic, nothing is sent anywhere, and the page has no route in the application.
The check `node docs/previews/068-provize-nahled.check.mjs` (Playwright from `apps/web`, screenshots
into `$AYVO_SCREENSHOT_DIR`) covers 390 and 1440 px, both themes, roles, the keyboard, the first
screen, the list, the detail and the admin views.

**Billed period and the monthly rhythm (owner 2026-11-17).** The preview bar moves "Dnešek v
náhledu" along the synthetic scenario 20. 7. → 31. 7. → 1. 8. → 10. 8. → 15. 8. (also
`#<person>/<tab>/<YYYY-MM-DD>`). The salesperson's overview names the month of the amount ("K
fakturaci za červenec" next to the hotels of August). Admin → "Přehled obchodníků" (the chosen
service month: hotels, the approved amount, the state, Rozpis, Doklad, the sum) and "Kontrola
podkladů" was merged into "Přehled obchodníků": open a salesperson for the source invoices,
the flags, the re-check, 1. Zveřejnit podklad, 2. the received invoice, 3. the payout; bulk
publication of the checked statements; the running month as continuous validation. Alena's plan 20/24/5 stays unchanged throughout.

## 11. The PR 1a prototype (history; implemented as #192)

The migration, module, contracts, the Nastavení and Moje podmínky pages, and the tests of §6 for
PR 1a, plus §8.1. It is a prototype for the review of the model: it is not proposed for merge until
the owner approves §3.1, and its migration has run only in the per-run test databases
(`ayvo_test_*`, created and dropped by the test setup), never on DEV.

The review branch `feat/commission-terms-1a` starts at `origin/main` and carries only the code and
tests of 1a (no preview, no calculation prototype, no docs). Its main migration
`20261117090100_commission_terms` runs in an explicit `BEGIN … COMMIT`: a forced failure after
the catalogue writes left the permission, its ADMIN grant and the table behind on the first
prototype (`1e0aca4`), and leaves nothing with the fix (`test/commission-terms-migration.e2e`,
the mechanism of #136's `account-audience-migration`). The enum value stays in its own earlier
migration.

## 12. PR 1b — the form steps and the regressions (history; implemented as #193 without the estimate)

Follows the model §3.2–§3.3 and the API §4.2; nothing here is a new rule unless marked
**(proposal)**. No 1b schema exists yet, on any database.

### 12.1 The hotel card → "Obchodník (provize)" (`sales:manage` + `hotels:read`)

**A. After signing — source `CONTRACT`** (a signed draft of this hotel exists):

1. **Zdroj.** A list of candidates from `signedAcquisitionSources(hotelId)`: `SN-… rev. N`,
   signed on, the prospect `AKV-…`, the contract's "Začátek" (`start_on`). The admin picks one, or
   "Ruční přiřazení" (B). Nothing is pre-chosen when there are two or more.
2. **Obchodník.** Prefilled with the prospect's owner (`prefilled_salesperson_id`). The admin may
   pick another eligible salesperson (active + `sales:work`), or "nikdo" (a house account). The
   form says "změněno oproti nabídce" when it differs.
3. **První zpoplatněný měsíc** (revision 1 only). Prefilled with the month of `start_on`, shown
   as "Ze smlouvy: Začátek 1. 6. 2027 — podpis neprokazuje první zpoplatněný měsíc". A month
   field and a required checkbox **"Potvrzuji první zpoplatněný měsíc"** (`confirmCommissionStart:
true`). Another month than the prefilled one keeps `contract_start_on` and shows the
   difference; the reason must explain it.
4. **Platí od** (`effective_from`). For revision 1 the same month as step 3 **(proposal)**.
5. **Podmínky.** Read-only: the salesperson's valid terms version that will be bound as the
   snapshot (`ON_ATTRIBUTION`), or the amber state "Chybí podmínky provize — hotel se přiřadí bez
   podmínek, žádný podklad".
6. **Shrnutí a potvrzení.** Who, from when, the first commission month, the bound rates and the
   estimate for month 1 ("Odhad"); the reason (required) and the confirmation (`confirm: true`).
   Enter in the reason submits; errors are shown at their field.

**B. An existing hotel without an acquisition source — `MANUAL`:** the note "Bez zdrojové
akvizice", no candidate, no prefill. Steps 2–6 with the salesperson chosen by hand and the first
charged month **entered** (no default, the checkbox still required). The portfolio shows the
hotel "Bez odhadu" until Finance has an invoice (PR 2), because no signed price exists in the core
**(proposal, as in the preview)**.

**C. A later change of salesperson (revision ≥ 2):** step 3 is read-only (the trigger keeps
`commission_start`); a new `effective_from` month and a reason. The bound rates of the new
salesperson are written in the same transaction (§3.3).

Errors per field: `CONTRACT_NOT_SIGNED`, `CONTRACT_OTHER_HOTEL` (step 1),
`SALESPERSON_NOT_ELIGIBLE` (step 2), `EFFECTIVE_FROM_INVALID` (steps 3–4),
`COMMISSION_START_NOT_CONFIRMED` (422, the checkbox missing — **proposal**, to add to §4.2),
`409 CONCURRENT_CHANGE` (the whole form: "Mezitím se přiřazení změnilo, načtěte znovu").

### 12.2 Obchod → Provize → Portfolio (`sales:work` own; `sales:manage` all)

A month picker (default: the current month, Europe/Prague). Per hotel: code, name, city, since,
the source (`SN-…`, `AKV-…` only in the salesperson's scope, Q4), the commission month `k`, the
applied rate, the estimated base and estimate ("Odhad"), or "Chybí podmínky provize" / "Bez
odhadu". Totals at the top marked "není částka k fakturaci". A manager additionally picks a
salesperson and sees totals per salesperson. The states "Čeká na úhradu", "K výplatě" and the
next payout come only with PR 2/3; 1b never shows them as known. The empty state: "Hotel se vám
započítá, až admin při podpisu potvrdí…" (as in the preview).

### 12.3 Regressions for PR 1b

On the existing preview and model (no schema needed, run before and after 1b):

- the preview check `node docs/previews/068-provize-nahled.check.mjs` (145 checks: 390/1440, light/dark, roles, keyboard, empty state,
  missing terms, the acceptance case, the two hotel situations) stays green with the steps of
  §12.1 mirrored in the preview's hotel cards;
- `node --test docs/prototypes/068-commission-calc.test.mjs` stays 17/17 (k, the boundaries 24/25
  and 36/37, the original rate on a late payment).

On the code (1b e2e, real auth, besides the §6 PR 1b column):

- 1a stays green: `commission-terms.e2e`, `commission-terms-migration.e2e` (1b's migration gets
  the same forced-failure test and an explicit transaction);
- the form: without the checkbox → 422 and nothing written; another month than `start_on` keeps
  `contract_start_on`; `MANUAL` without a month → 422; a hotel of another draft →
  `CONTRACT_OTHER_HOTEL`; an unsigned revision → `CONTRACT_NOT_SIGNED`;
- two admins attributing the same hotel at once: one 201, one 409 (advisory lock
  `sales-attribution:<hotel>`);
- a salesperson: 403 on the hotel card routes, only their own hotels in the portfolio, no
  contact/address/orders; a custom role with `sales:manage` cannot use the explicit terms change
  (`sales:commission_terms_manage`, security administration);
- existing suites untouched in behaviour: contract drafts and signed documents, hotels, Obchod
  prospects and their scope, `identity.e2e` (every route declares its rule), the role matrix;
- rollback: the code before 1b against a database migrated by 1b (`rollback-compat` with a seed of
  attributions and bindings) and `permissions-forward-compat`;
- Playwright: the hotel card A and B by keyboard, the portfolio at 390 and 1440 without sideways
  scrolling, the empty state and the missing terms.
