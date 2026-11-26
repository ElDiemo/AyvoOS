# ADR 0049: Hotel margin — actual consumption and events from the core, standard prices and the overview in Finance

- **Status:** Proposed — for the owner's approval and the independent review. Nothing is
  implemented, migrated or switched on. **No Finance code is written until the boundary (§2) is
  approved.**
- **Date:** 2026-11-19
- **Deciders:** the owner (business rules); independent review (boundary)
- **Builds on:** ADR 0001 (modular monolith), 0006 (append-only), 0007 (billing apart from
  logistics), 0011 (reuse cycle), 0039 (Finance as its own unit, core contracts), 0046 (commissions)
- **Details:** doc 071 (rules, contract, tables, overview, example);
  `docs/prototypes/071-hotel-margin.mjs` (reproducible calculation on fictional data)

## Context

The owner wants to see, for every hotel and month, what the hotel brings and what it costs. Map of
today's sources (19. 11. 2026, `main` 09e82e7):

- **Revenue** exists in Finance: `invoice_lines`, hotel × billed month, without VAT. Only TEST
  invoices exist yet.
- **Purchase prices** exist only in core procurement, per goods receipt line. There is no
  valuation method, and Finance cannot read them.
- **Consumption** exists in the core: inventory movements linked to bottle events. Quantities
  only, no money.
- **First use vs refill:** a refill is not yet possible on `main`. The distinction comes with the
  bottle-cycle R3a anchor (`bottle_fill_circulations`: LABEL_APPLIED vs REUSE_READY).
- **Crates:**
  - dispatch: orders → allocations → crate cycles DISPATCHED → shipments and parcels;
  - return: `return_receipts`.
- **Transport costs:** recorded nowhere.
- **Commissions:** approved statements in Finance (#198–#201, under review).

## Decision

### 1. Owner decisions (2026-11-19)

1. **Standard prices are entered in Finance and effective from a date.** Nothing is valued from
   goods receipts; procurement prices stay where they are and are not read.
2. **The core supplies only actual consumption and events.** No prices, no money. Finance prices
   them.
3. **New bottle and refill:**
   - a **new bottle** carries its packaging and fill **per actual consumption**: body, label, pump
     and liquid as consumed;
   - a **refill** carries the fill;
   - the bottle, the label and the reused pump are **never counted again**.
4. **Transport per crate:**
   - **outbound** at the crate's **dispatch**;
   - the **return** rate only at the **receipt of that returned crate**.
5. **The hotel × month overview** shows, separately:
   - revenue;
   - costs: materials, outbound and return transport, commissions;
   - the margin **before** and **after** commission.
6. **A hotel's contribution is not the company result.** Rent, the accountant, wages and other
   overheads are never allocated to a hotel; the company result is a different figure.

### 2. Boundary (proposal)

- **The core** owns consumption and logistics events.
  - It exposes one new read-only internal contract for Finance (ADR 0039, service token): per hotel
    and month, the dispatched crates, their bottle circulations with kind (FIRST_USE / REFILL) and
    actual consumption (item, item kind, unit, quantity, day), and the returned crates received.
  - It never sends prices and never computes money.
- **Finance** owns:
  - the standard prices and transport rates (append-only versions);
  - the valuation;
  - the overview.
  - Revenue comes from its own invoice lines, commissions from its own approved statements.
  - It never reads core tables or procurement prices.
- **Access:** the overview and the prices are for ADMIN only (proposed permissions
  `finance:margin_read`, `finance:margin_prices_manage`). Never visible to a hotel or a
  salesperson.

### 3. Defaults for the first DEV version (proposal; doc 071 §4–§5)

- **Currency:** CZK without VAT.
- **Validity of prices and rates:** the version in force on the day of the cost event:
  - the greatest effective-from date ≤ that day;
  - among versions with the same effective-from date, the latest recorded one;
  - corrections are new versions recorded with a reason, never edits.
- **Day of each cost:**
  - a consumption is priced on its own day;
  - outbound transport on the dispatch day;
  - return transport on the receipt day.
- **Month of each cost:**
  - materials in the month the crate was dispatched to the hotel;
  - return transport in the receipt month;
  - commissions by the item's billed month, approved statements only.
- **Recipient:** the hotel of the crate a bottle was **dispatched** in; a repack after filling
  moves no cost and consumes nothing (doc 071 §3.3).
- **One unique key per amount** from its source row (invoice line, inventory movement, crate
  cycle, return receipt line, statement item), checked over the whole input; a duplicate is a
  data error, never counted twice (doc 071 §3.3).
- **Without commission ≠ not yet approved:** an explicit 0.00 only from the core attribution
  (Firemní hotel, `recipient: null`; before the commission start) or an approved statement; a
  missing or unapproved statement, or no attribution, makes the month incomplete (doc 071 §3.4).
- **Return day = the scan of that crate** on the return receipt; a return without a proven cycle
  or hotel is an **unassigned cost** for the admin, never assigned automatically, and counts only
  in the company view (recommended DEV default for the owner to confirm; doc 071 §3.5, §10.1).
- **Large volume is read over several calls** (§4); a hotel whose source was not read whole
  (PARTIAL) or does not add up (UNRECONCILED) shows no costs and no margin (doc 071 §3.6).
- **A missing price, rate, revenue or approval makes the hotel × month visibly incomplete.** The
  known costs are shown as "known so far", the margin is not shown, and the reasons are listed.
  Never a zero.
- **Rounding:** each cost line half-up to 0.01; totals are sums of the rounded lines. To be
  confirmed by the accountant, like O9 in ADR 0046.

### 4. Reading over several calls (proposal; doc 071 §3.6, re-review 2026-11-20)

- **A time watermark is not a stable listing.** `now()` is the writer's transaction start, so a
  transaction begun before the first page and committed between pages appears half. A sequence
  is taken before the commit, so a seq cursor can lose a row. No variant holds a DB transaction
  across the network (no `pg_export_snapshot`).
- **Variant S (stable over several calls):**
  - the first call returns `pg_current_snapshot()`;
  - every later call keeps only rows with `pg_visible_in_snapshot(created_xid, snapshot)`;
  - needs an `xid8` column `created_xid` (default `pg_current_xact_id()`) on each append-only
    source table, a core migration.
- **Variant H (recommended for v1, no core schema change):**
  - each call returns whole hotels from one short REPEATABLE READ transaction, so each hotel is
    consistent as of its own `readAt`;
  - different hotels may be of different moments, and the overview says so;
  - the fingerprint covers every money-relevant value (hotel, crate cycle, days, quantities,
    units, item, kind and state), not only keys and counts, so a changed value with the same keys
    and counts is a mismatch, never computed;
  - a hotel row has two read moments, the core's `readAt` and Finance's own `financeReadAt`
    (revenue, commissions, prices, rates), and never claims a common one;
  - **no sum over hotels in v1** (no company view, no totals). A core check cannot cover
    Finance's inputs, and a late transaction can be in one hotel's read and not another's. A sum
    needs a later proposal that proves the consistency of all its inputs;
  - an inconsistent aggregation is never merged.
- **Hard total deadline** (60 s, proposal): checked before every try, retries included. Each try
  gets `min(10 s, the remaining budget)`. After the budget, nothing is tried, and the overview
  never reads in the background.
- The owner chooses H or S for v1 (doc 071 Q13).

## Consequences

- No margin needs procurement data, a valuation method or depreciation. These are left for later
  decisions, not hidden in v1.
- **First use vs refill depends on R3a** (bottle cycle) being merged. Until then the core reports
  only first uses.
- **The return rate is never estimated.** An unreturned crate costs nothing until it comes back.
- **Not in v1:**
  - washing, labour, the washed-pump pool, bottle depreciation and losses;
  - any allocation of overheads;
  - live revenue (it opens with doc 040 §5/§13);
  - any accounting, VAT or payment logic.
- **Order after approval:**
  1. core contract (read-only, tests against real rows);
  2. Finance migration (prices, rates; append-only, DB checks);
  3. overview (read-only);
  4. UI.

  Each part is a separate PR.
