# ADR 0046: Sales commissions — attribution and terms in the core, calculation and statements in Finance

- **Status:** Proposed — for the owner's review and the independent review. Nothing here is
  implemented or switched on. It replaces the earlier text of this number in draft PR #141
  (2026-11-08). That text called the rates and the release rule "confirmed by the owner". The
  owner's brief of 2026-11-16 says that the start of the period and the release are proposals for
  review. Updated the same day with the owner's confirmed clarification: commission terms per
  salesperson in **Obchod → Provize → Nastavení** (§2a). A second clarification the same day
  decides the start and the payout (§4) and takes precedence over the earlier proposals Q1/Q2.
- **Addendum 2026-11-18:** §0 below takes precedence over every conflicting point of §1–§4 (the
  hotel's payment is never an input; the admin approves in Obchod → Provize). PR 1a (#192) and PR
  1b (#193) are implemented, approved and on DEV; the Finance part is proposed for approval.
- **Date:** 2026-11-16 (addendum 2026-11-18)
- **Deciders:** the owner (business rules, model); independent review (boundary)
- **Builds on:** ADR 0001 (modular monolith), 0006 (append-only history), 0007 (billing apart
  from logistics), 0031 (Obchod, ownership scope), 0039 (Finance as its own runtime unit), 0041
  (core runtime role), 0043 (contract drafts), 0048 (Finance terms revisions); doc 034, 040, 041, 045. Details, the models of PR 1a/1b and the test map are in doc 068.

## Context

The owner approved starting work on commissions for salespeople (2026-11-16). A salesperson sees
their portfolio of hotels and what they will earn for each hotel, and invoices AYVO from a closed
monthly statement.

What exists today (verified on `origin/main` 690f769, doc 068 §1):

- **Obchod** (`sales_prospects`) has an owner per prospect. Doc 034 and ADR 0031 say: "Nothing
  links prospects to hotels".
- **The only real link between an acquisition and an operational hotel is a contract draft**
  (`contract_drafts`). It is linked to a prospect and to a hotel. The hotel link is checked
  against the hotel the draft names. Once a revision has a signed original
  (`contract_signed_documents`), the link never changes (DB trigger `contract_drafts_signed_lock`).
- **Hotels** (`customers`) are created by hand. Their `created_by` says nothing about an
  acquisition.
- **Finance** keeps one billing agreement per hotel (`billing_agreements.hotel_id`). It is created
  by hand; `contract_number` is free text with no link to the draft's `SN-` code. Invoice lines are
  one per hotel agreement and month: billed rooms × unit price = amount without VAT. Payments are
  allocated per invoice, not per line. Only `TEST` invoices exist; live invoicing is blocked (doc
  040 §5, §13).
- Finance calls the core (`/api/internal/v1/finance/*`, service token + forwarded session). The
  core never calls Finance.

## Decision

### 0. Addendum 2026-11-18 — the closing without payments (takes precedence)

Owner, 2026-11-18. Details, the map of real inputs and the open rules: doc 069.

- **Rule.** For a closed calendar month M, Finance computes from the **valid issued hotel invoice
  lines without VAT whose billed period is M**, with the hotel's approved first paid month, the
  recipient in force for M and the stored rate version (core, #193). **The hotel's payment is
  never used.** One statement per salesperson (and currency) from the 1st of M+1; the **admin
  approves it in Obchod → Provize**; the salesperson then sees their state and one amount to
  invoice; their invoice by the 10th, a payout **plan** by the 15th.
- **Superseded:** §1 "the calculation from invoice lines, payments …" (payments removed); §4 step
  1 "Odhad" (not shown; #193 has no estimate); step 3 "Čeká na úhradu hotelu"; step 4 is now the
  rule (no longer a proposal); steps 5 and 8 "publish / Zveřejnit podklad" → **approve /
  Schválit**; the paragraph "A hotel's payment puts the item into the statement … (Hotel
  zaplatil)"; the open points about partial payments, the payment date and payments after
  publication (doc 068 Q2a, Q14, Q16 as payment questions). Step 9 and I4 ("Vyplaceno" with a
  bank movement) stay valid but are **not in this batch**: no mail, automatic payment or bank
  pairing.
- **Boundary.** Finance owns invoices, the closing, the calculation, the immutable approved
  statement and its audit. The core owns attribution, stored rate versions and identity. Only
  explicit authorised contracts: one new internal read, core → Finance answer (doc 069 §4); no
  table of the other unit is read; no new process.
- **Kept:** I1–I3, one statement per salesperson × month × currency, TEST never in a LIVE
  statement, idempotent and serialised approval, an approved amount never changed (later facts
  become items of a later statement).

### 1. Who owns what

| Unit              | Owns                                                                                                                                                                                                                                                                                                                                                                                                                    | Never                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core / Obchod** | The **attribution** of an operational hotel to one salesperson, effective from a month. Append-only revisions with who, when and why. The source of the attribution (a signed contract draft and its prospect, or a manual decision). The **commission terms of each salesperson** (initial rate %, its length in whole months, maintenance rate %; versioned, §2a) and the terms **applied to each attributed hotel**. | Amounts, invoices, payments or statements. It never reads Finance tables and never calls Finance.                                                       |
| **Finance**       | The calculation from invoice lines, payments and the applied terms. Monthly statements, corrections, the link to the salesperson's received invoice, the payout record.                                                                                                                                                                                                                                                 | Attribution or terms. It reads them only through the core contract (§3), never from a core table. Its own copy is a snapshot inside a closed statement. |
| **Internal web**  | **Obchod → Provize** (the portfolio from the core, the commission lines from Finance) and later **Finance → Provize obchodníků**.                                                                                                                                                                                                                                                                                       | Its own calculation. Every number comes from the API that owns it.                                                                                      |

- Rates and lengths are **data of a salesperson's terms version** (§2a), entered by the owner or
  an admin. Examples: 20 % / 24 months / 5 %, or 10 % / 36 months / another maintenance rate.
  Nothing is a constant in code, and there is no default plan: a salesperson without terms has
  none.
- **The attribution is not the prospect's owner.** When a draft is signed, its prospect's owner at
  that moment is offered as a **prefill**. A person with the right to attribute confirms it. A
  later change of the prospect's owner, of the hotel's author or of who cares for the hotel never
  changes an attribution by itself.
- v1 has **one recipient per hotel and month**. A month belongs to the attribution effective on its
  first day. A split between salespeople is out of scope.

### 2. Attribution in the core (PR 1b, doc 068 §3.2)

- A new core module **`commissions`** under the Obchod function. It is a new module because
  `contracts` already imports `sales`, so `sales` importing `contracts` would make a cycle. It
  writes only its own table, `sales_hotel_attributions`. That table is append-only and
  bitemporal: `effective_from` is the 1st of a month, and `revision` is the order in which the rows
  were recorded. For a month, the newest recorded revision with `effective_from` ≤ that month
  wins, as in Finance's `agreement_versions`. A correction is a new revision, never an update.
- It reads hotels through `HotelsService`, prospects through `ProspectContextService`, and signed
  drafts through a new read method exported by `contracts`, never through their tables. FKs keep
  the references valid. A source `CONTRACT` points at the signed original, by draft and revision.
- Access comes from the **existing permissions**, evaluated per request:
  - attribute, correct and read a hotel's history: `sales:manage` + `hotels:read`, as for linking
    a draft to a hotel (ADR 0043 §3);
  - read the portfolio: `sales:work`. The caller sees only the hotels attributed to them in the
    month asked for. With `sales:manage`, the caller sees everyone and the results per
    salesperson.
  - Out of scope means 404, and the hotel is missing from every list, count and export.
- Writes are idempotent per `requestId`. They are serialised per hotel (an advisory lock, then
  `expectedRevision`), so a stale write gets `409 CONCURRENT_CHANGE`.
- The attributed person must be an active user with `sales:work` at the moment of the write. A
  later deactivation keeps the history.

### 2a. Commission terms per salesperson (PR 1a; owner, 2026-11-16; history rule for review)

Confirmed by the owner:

- In **Obchod → Provize → Nastavení**, the owner or an admin picks a salesperson and sets:
  - the **initial rate %**;
  - its **length N** in whole months;
  - the **maintenance rate %**.
- The salesperson sees their own terms read-only. Only the admin manages them, and the API
  enforces that:
  - a new permission, `sales:commission_terms_manage`, is granted only to ADMIN by its migration.
    It carries the catalogue flag `security_admin`, so the database refuses it in every custom
    role and SALES can get it only by a reviewed migration (doc 068 §8.1, as
    `identity:portal_grants_manage`);
  - reading one's own terms needs `sales:work`; reading everyone's needs the manage permission;
  - `sales:manage` alone does not grant it, and no route edits terms with `sales:work`.
- The maintenance rate applies **from commission month N+1**. Months 1…N use the initial rate.
  The month number counts from the hotel's commission start (§4: the first month the hotel pays
  from under its signed contract). A change of salesperson never moves that start.

Proposed history rule (for review):

- **Versions.** The salesperson's terms are append-only versions (1, 2, … per salesperson). The
  newest recorded version is the **valid version**. A change of terms is a new version with a
  reason, never an update.
- **A newly attributed hotel takes the valid version.** When a hotel is attributed to a
  salesperson, a hotel binding is written in the same transaction. The binding is a **snapshot of
  the rates and N** together with the version it came from.
- **A new valid version applies to new hotels only.** Hotels already bound keep their snapshot.
- **An existing hotel changes only explicitly and for the future.** The admin writes a new
  binding for that hotel with a reason. Its effective month must be later than the month in which
  it is recorded; the database refuses a past or current month.
- **An approved statement is never rewritten.** Each statement item keeps the binding and the
  rates it used. A later change can only produce a traceable correction in a later statement.
- **Missing terms.** A salesperson may be attributed a hotel without any terms version. That
  hotel shows **"Chybí podmínky provize"**:
  - no commission amount and no estimate of commission (the base estimate may still show);
  - Finance creates **no statement item** for it.

  Binding terms to such a hotel later is an explicit admin action (Q11 in doc 068).

- Values are exact decimals, 0–100 with at most two decimals, and are refused rather than
  rounded. 0.00 is an explicit rate, not a missing one. N is a whole number ≥ 1. Any upper bound
  is an open question; none is invented.

### 3. The contract Finance → Core (PR 2, after this ADR is accepted)

- `POST /api/internal/v1/finance/sales-attributions/lookup`
  - Takes `{ sessionToken, hotelIds[≤200], fromMonth, toMonth (≤ 24 months) }`.
  - Returns, for each hotel and month:

    ```
    { hotelId, month, salespersonId | null, displayName, attributionRevision, effectiveFrom, commissionStart,
      terms: { bindingId, termsVersion, initialRate, initialMonths, maintenanceRate } | null }
    ```

    plus one `fingerprint` of the set. `terms: null` means missing terms.

  - The core checks the forwarded session: `finance:commissions_manage` reads all hotels;
    `sales:work` reads only the caller's own lines. Both are evaluated now, never cached.
- Versioned path (`v1`), the token audience `finance`, and the timeouts and retries of ADR 0039
  §4: 2 s, one retry for a read. Unavailable means `503`, never a guess.
- **No network call inside a database transaction.** Finance reads the attributions first. Then,
  in one Finance transaction, it locks the month and the salesperson's statement slot. It checks
  the invoice and payment state and writes the statement with the attribution revision and the
  fingerprint for each item, and the item's terms snapshot. Approval re-reads the contract. A different fingerprint refuses with
  `ATTRIBUTION_STALE`, as `PREVIEW_STALE` does for accounting exports.
- **A change of attribution after a closed statement** never rewrites it. The next statement
  carries a traceable correction: a negative item for the old salesperson, a positive one for the
  new, with the original period and rate. This correction needs Q6 of doc 068.

### 4. Calculation and statements in Finance (PR 2 preview, PR 3 statements; before any switch-on)

- **Base:** the amount without VAT of an **issued, not cancelled invoice line**. The line has its
  identity `(invoice, line_no)`, its hotel, period month and currency, and the base is rooms × unit
  price exact.
  - Each source line counts **at most once**: a unique key on the statement items, also under a
    repeat or two concurrent closings.
  - Exact decimals. The line rounding rule is an open question (Q3); nothing is rounded until it
    is decided.
  - One total per currency; currencies are never mixed.
- **Decided by the owner (2026-11-16, second clarification; replaces the proposals Q1/Q2):**
  1. **At signing, attribute and estimate.** When the signed original is recorded, the admin
     confirms the salesperson who won the hotel. The prospect's owner is the prefill; the
     confirmation is never automatic. The hotel then counts in that salesperson's portfolio, with
     an **estimated commission**: the signed revision's rooms × price × the bound terms, marked
     **"Odhad"** and never an amount to invoice.
  2. **Start.** The first commission month is the **first month from which the hotel pays under
     the contract**. The signing proves only the agreed start date (`start_on`, printed as
     "Začátek"), not the first charged month (doc 068 §8.3), so the month of `start_on` is the
     prefill and the admin **confirms the start explicitly** at attribution. The core holds it
     on the attribution (doc 068 §3.2). An existing hotel without a signed draft gets an explicit
     start at introduction. A change of salesperson never moves it.
  3. **Invoice issued.** The item shows the **actually calculated commission** from the invoice
     line, in the state **"Čeká na úhradu hotelu"**.
  4. **Billed period (owner 2026-11-17 — proposal for review; replaces the earlier "payment
     month").** The item belongs to the statement of the **invoice's billed period**: a valid
     issued invoice for billed service, without VAT. The hotel's payment is Finance's information
     outside the salesperson and never conditions or moves it. Example: the first invoice on 15. 7. for July service → the July period, one statement after the July closing, the
     salesperson invoices in August; an invoice issued in July in advance for August → August. An
     effective pause or termination ends new commissions from unbilled service; a billed part
     before it stays. A cancelled invoice yields nothing (after publication: a correction in the
     next statement). The payout days follow the rhythm of step 7 (doc 068 C12). Proposed hotel invoicing
     standard: the 1st day for the current month, due per the contract; a mid-month start (Q17)
     is open; the days of the rhythm are in step 7.
  5. **Finance's review before publishing (doc 068 §3.7).** Per item the valid invoice line, the
     service period, the base without VAT, the effective attribution and the rate; a missing or
     conflicting input flags the item and blocks only that salesperson's statement until resolved;
     the publication is bound to the fingerprint of the check (a changed source forces a
     re-check), and a second processing returns the same statement.
  6. **Monthly rhythm (owner 2026-11-17, confirmed; doc 068 C12).** From the 1st the verified
     actual amount of the previous service month is published; by the 10th the salesperson
     delivers one invoice; by the 15th a timely received, checked invoice is paid out. Continuous
     validation runs before the closing; a statement with a conflict stays "Zpracovává se" without
     an amount to invoice. A late invoice goes to the next payment run with the original statement
     (recommendation). A mid-month start stays open (Q17).
  7. **Invariants before any Finance implementation (owner 2026-11-17; doc 068 §3.8, tests
     S18–S21).**
     - **I1** One valid accounting item (an issued invoice line) → **at most one regular
       statement item**, across closings, inputs and periods. A storno or a change produces a
       separate, typed correction, never a second regular item.
     - **I2** An **approved (published) statement is immutable** and arises **only from a checked
       statement whose sources are at their current version**: the publication is bound to the
       review's fingerprint; a newer invoice version, a changed attribution or a missing input
       refuses it. There is no other way to approve. What is computed later is shown against the
       published amount as a difference and settled by a correction.
     - **I3** **One salesperson invoice ↔ one statement.** The acceptance checks the issuer (the
       statement's salesperson), the document, the commission base (the net amount without VAT =
       the statement total) and the currency; an invoice number of an issuer never serves a second
       statement. The **payout amount is the invoice's payable amount**; the commission base stays
       without VAT. No VAT rate is assumed.
     - **I4** **"Vyplaceno" only with a documented, booked outgoing bank movement** with the same
       payee, amount (the payable amount), currency and reference. First as a **manual assignment
       of the bank movement in Finance**: an unclear, partial or duplicate movement changes no
       state and says why.
     - Kept: the rhythm 1/10/15, the service period from the valid issued invoice, the difference
       between computed and published, exceptions resolved before a statement is issued.
       Nothing of this is active: no Finance migration, no invoices or payments.
  8. **Where the admin works (owner 2026-11-17).** One place: Obchod → Provize → Přehled
     obchodníků — the month, a salesperson's detail with the source invoices, "Zveřejnit podklad",
     the check of the received invoice and the confirmation of the payout, and a bulk publication
     of checked statements. Finance owns the data, operations and permissions (`finance:*`
     permissions, ADMIN in v1); the web page calls Finance's API like the other Finance pages, the
     core never calls Finance (ADR 0039), and the UI holds no business rule of its own.
  9. **Payout date and "Vyplaceno".** The date of the payout is shown only as confirmed by
     Finance. The statement becomes **"Vyplaceno"** only after the actual payout is recorded by
     Finance.
- **One monthly statement, one invoice (owner 2026-11-17, explicit).** In one currency (v1:
  CZK only) Finance keeps **one statement ("Měsíční podklad") per salesperson × period**,
  and the salesperson issues **one invoice on its total**; a hotel is only an item of its
  breakdown, never a separate invoice. A hotel's payment puts the item into the statement being
  prepared ("Hotel zaplatil"); only the **publication of the complete statement** makes it
  "Připraveno k fakturaci" with the one download (the total and the breakdown). A **published
  statement is fixed**: no item is added, and no second statement or invoice follows in its month.
  Payments at the end of the month or after the publication, and the payout timing against the
  closing, are **open (doc 068 Q16)**; until decided such an item is held.
- **What a salesperson sees (owner 2026-11-17, doc 068 C10).** The salesperson does not follow the
  hotels' receivables. Their projections carry only the own commission, its period and "V podkladu
  za …" or "Zatím v podkladu není"; a hotel's invoice number, payment state, date and amount stay in
  Finance's authorised view and are never sent to them. Their own invoice number and state stay in
  the overview. The count of active hotels is a portfolio fact, separate from the statement: a late
  payment of a former hotel enters the statement of the original salesperson at the original rate
  when the entitlement arises and the item was not included yet, without changing that count.
- **Still open (doc 068 Q2a, Q2b, Q7, Q14, Q16; none blocks PR 1a/1b):**
  - partial payments of a hotel invoice (including a summary invoice);
  - a salesperson's invoice delivered after the payout date;
  - contractual pauses and whether paused months count towards N;
  - which date is "the month of the payment": the bank booking or the allocation to the invoice.
  - payments at the end of the month or after the statement is published, and the payout timing
    against the closing (Q16).

  Under the billed-period proposal (step 4) a partial payment and the payment date no longer
  condition a commission; they remain Finance's information.

- **TEST and live data:** TEST invoices count only where `APP_ENV` is not `production` and in
  isolated tests. On PROD only live invoices in a supported state count, and none exist today
  (verified in code: `CHECK (kind = 'TEST')`, issuing refused with `APP_ENV=production`; doc 068
  §8.4). The statement accepts a **listed** invoice kind, never "anything but TEST".
- **Outages:**
  - **Finance down:** the core portfolio works, and the commission panel says "Finance je
    nedostupné". Nothing is guessed.
  - **Core down:** Finance answers 503 to everyone (ADR 0039: no principal without the core), so a
    closing is postponed. Closed statements stay as they were and are readable again when the core
    returns.
  - A repeated or interrupted closing is safe: idempotent per request id, one statement per
    salesperson × period × currency.
- **Out of scope:** payments to salespeople, automatic invoices for or by a salesperson, sending,
  and a scheduler. The salesperson's own invoice is recorded as a received Finance document (doc 039) or by its number until that link exists.

## Consequences

### Positive

- Attribution and money have one owner each, and the direction of calls stays the one of ADR
  0039: Finance → Core.
- The first PRs are core-only and need no change in Finance and no new runtime. The only new
  permission is `sales:commission_terms_manage`, for ADMIN. They can be reviewed and rolled back
  like any core release.
- Rates, lengths, the start and the release are data with no default, so nothing assumed is ever
  switched on. A hotel without terms produces nothing to invoice.
- The change is additive: an older core after a rollback ignores the new permission and tables
  (doc 068 §8.2).
- Terms and attribution change together in one core transaction, so a hotel is never attributed
  under terms that were never bound to it.

### Negative

- The salesperson's screen combines two APIs and shows two states: the portfolio, and commissions
  "unavailable".
- Until live invoicing exists (doc 040 §13), PROD has nothing to calculate. Commissions are
  provable only on DEV with TEST data.
- Payments are allocated per invoice, so a summary invoice of several hotels is fully paid only as
  a whole. Its partial payment is the open Q2a.

## Alternatives considered

- **Attribution as the prospect owner, derived on the fly.** Rejected: a change of who works on
  the prospect would move money, and hotels without a draft would have no recipient.
- **Terms (plans) in Finance.** Rejected after the owner's clarification: the terms are set per
  salesperson in Obchod and must be bound to a hotel at the moment of attribution. With the terms
  in Finance, that would need a write call from the core to Finance, or a binding that does not
  exist until Finance learns about it.
- **Attribution in Finance.** Rejected: who sold a hotel is a sales fact, scoped by Obchod's
  ownership rules, and Finance would need the user directory.
- **The core reading Finance for the portfolio.** Rejected: it reverses the direction of ADR 0039,
  and a Finance outage would then break Obchod.
- **Stamping the salesperson on the invoice line.** Rejected: issued invoices are immutable
  documents for the customer, and a later correction of attribution would be impossible without a
  new invoice.
