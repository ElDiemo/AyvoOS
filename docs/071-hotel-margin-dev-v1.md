# 071 — Hotel margin: first DEV version (hotel × month)

Status: **proposal for the owner's approval** (owner brief 2026-11-19). Nothing here is implemented,
migrated or switched on. Finance code waits for the approval of the boundary (ADR 0049 §2). Every
point is marked **[OWNER]** (an explicit owner decision of 2026-11-19) or **[PROPOSAL]**.
Reproducible calculation on fictional data: `docs/prototypes/071-hotel-margin.mjs`, check with
`node --test docs/prototypes/071-hotel-margin.test.mjs`.

## 1. What the overview answers

For one hotel and one month, what the hotel brought and what it cost:

| Line                       | Source                                                                                             | Note                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Výnos** (revenue)        | Finance `invoice_lines` of the hotel, billed month = M, not cancelled                              | [PROPOSAL] without VAT; DEV = TEST invoices, LIVE once doc 040 §5/§13 opens |
| **Materiál** (materials)   | core: actual consumption of the bottles dispatched to the hotel, priced by Finance standard prices | [OWNER] new bottle = packaging + fill per consumption, refill = fill only   |
| **Doprava tam** (outbound) | core: crates dispatched to the hotel × Finance rate per crate                                      | [OWNER] at dispatch                                                         |
| **Doprava zpět** (return)  | core: returned crates received from the hotel × Finance rate per crate                             | [OWNER] only at the receipt of that crate                                   |
| **Provize** (commission)   | Finance approved commission statement items of the hotel                                           | [PROPOSAL] by the item's billed month; approved only                        |
| **Marže před provizí**     | revenue − materials − outbound − return                                                            | [OWNER] shown separately                                                    |
| **Marže po provizi**       | margin before − commission                                                                         | [OWNER] shown separately                                                    |

[OWNER] A hotel's margin is its **contribution**. It is not the company result: rent, the
accountant, wages and other overheads are never allocated to a hotel (§6).

## 2. Map of today's sources (summary)

Details: the map of 19. 11. 2026.

| Input               | Today                                                                                         | Gap                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Revenue             | Finance `invoice_lines` (hotel × month, rooms × price)                                        | TEST only                                                                        |
| Prices              | core procurement per receipt line (`goods_receipt_lines`, `goods_receipt_line_costs`)         | **not used** [OWNER]: standard prices in Finance instead                         |
| Consumption         | core `inventory_movements` (LABEL_APPLICATION, FILL, …) linked to bottle events and BOM lines | quantities only, which is all that is needed                                     |
| First use vs refill | on `main` a refill is impossible                                                              | R3a `bottle_fill_circulations` (anchor LABEL_APPLIED vs REUSE_READY), not merged |
| Crate out           | orders → allocations → crate cycles DISPATCHED, shipments/parcels                             | no transport cost anywhere                                                       |
| Crate back          | `return_receipts` (+ lines with the returned cycle)                                           | no return-transport cost anywhere                                                |
| Commission          | Finance statements (#198–#201, under review)                                                  | per hotel through items                                                          |

## 3. Boundary and contract [PROPOSAL]

### 3.1 Core contract (read-only, ADR 0039)

`GET /api/internal/v1/finance/margin/activity?month=YYYY-MM&hotelIds=…` (service token, ≤ 200
hotels per call, like the commission contract). It returns **events and quantities, never money**:

- `circulations[]`: one per bottle filled and dispatched in a crate of the hotel's order in M.
  - Fields: `hotelId`, `crateCycleId`, `dispatchedOn` (Prague day), `bottleId`.
  - `kind`: `FIRST_USE` (anchor LABEL_APPLIED) or `REFILL` (anchor REUSE_READY, R3a).
  - `consumed[]`: `item` (inventory item code), `itemKind` (BOTTLE_BODY | LABEL | PUMP | LIQUID |
    OTHER), `unit`, `qty` (exact decimal string), `on` (day of the movement).
- `dispatches[]`: `hotelId`, `crateCycleId`, `dispatchedOn`.
- `returns[]`: `hotelId`, `crateCycleId`, `receiptId`, `receivedOn`. Only crates actually
  received.

Rules:

- The core reports **only actual consumption**. For a refill that is the fill: R3a consumes the
  FILL BOM without PUMP lines, and the washed pump comes from the pool without a stock record.
- If the core ever reported a bottle body or a label on a refill, Finance refuses it as a data
  error (`REFILL_CARRIES_PACKAGING`). It is never priced.
- A new pump really issued on a refill would be actual consumption and priced (question Q3).
- Core down = Finance 503, never a partial overview.

### 3.2 Finance tables (not implemented)

- `margin_standard_prices`:
  - columns: `item`, `unit`, `price` NUMERIC(19,4), `currency` = CZK, `vat` = EXCLUDED,
    `effective_from` (day), `recorded_at`, `recorded_by`, `reason`;
  - append-only, a correction is a new version;
  - unique (`item`, `effective_from`, `recorded_at`); CHECK price ≥ 0.
- `margin_transport_rates`:
  - `kind` OUTBOUND_CRATE | RETURN_CRATE, other columns as above, the unit is a crate.
- No table of results: the overview is **computed on read** in v1, like the commission preview.
  A frozen monthly snapshot is a later decision (Q8).
- Permissions: `finance:margin_read` and `finance:margin_prices_manage`, both ADMIN only, granted
  in the migration. They are new ADMIN codes, so they need #204 deployed first.

## 4. Validity of prices and rates [PROPOSAL]

- The version in force on the **day of the cost event**:
  - the greatest `effective_from` ≤ that day;
  - among versions with that same `effective_from`, the latest `recorded_at` as of the
    computation.
- Day of each cost event:
  - material: the day of the consumption movement;
  - outbound: the dispatch day;
  - return: the receipt day.
- Days are Europe/Prague. A version is never edited. A correction for the same effective day is a
  new version with a reason. An overview computed before the correction is reproducible with
  `asOf`.
- Prices are CZK without VAT; anything else is refused. The unit must equal the consumption's
  unit, and nothing is converted.
- Month of each cost:
  - materials in the **dispatch month** of the crate to the hotel;
  - return transport in the **receipt month**;
  - commission in the item's **billed month**;
  - revenue in the **billed month**.
- Rounding: each cost line = qty × price, half-up to 0.01 CZK. Totals are sums of rounded lines.
  The accountant confirms this together with O9 of ADR 0046.

## 5. Incompleteness is visible [PROPOSAL]

A hotel × month is **NEÚPLNÉ** when any of these is missing:

- a standard price for a consumed item on its day (or a different unit);
- a transport rate on the dispatch or receipt day;
- a valid invoice line for the month;
- an approved commission statement for the month.

Then:

- the overview lists every reason (item, day, bottle or crate);
- the known costs are shown as **"známé náklady zatím"**;
- the margin before and after commission is **not shown**;
- a missing value is **never 0**;
- the company view (§6) is also incomplete.

## 6. Hotel contribution vs company result [OWNER]

- **Hotel contribution** = margin after commission of that hotel × month, made only of costs
  directly caused by the hotel (§1).
- **Company result** is a different figure:
  - Σ hotel contributions − overheads that belong to no hotel: rent, the accountant, wages,
    washing and labour, depreciation, software, …;
  - it comes from accounting, not from this overview;
  - v1 shows it at most as a side note for contrast, and never as "zisk hotelu".
- The overview is labelled **"Příspěvek hotelu"**, never "zisk".

## 7. Example with two circulations (fictional; the prototype test)

Fictional hotel _Hotel Smyšlený_, one crate of 40 bottles.

**Prices (CZK without VAT):**

| Item           | From 1. 9. 2026 | From 1. 11. 2026                                      |
| -------------- | --------------- | ----------------------------------------------------- |
| bottle         | 18.00           |                                                       |
| label          | 2.50            |                                                       |
| pump           | 9.00            |                                                       |
| liquid         | 120.00 / l      | 130.00 / l (a correction to 128.00, recorded 20. 11.) |
| outbound crate | 95.00           |                                                       |
| return crate   | 80.00           |                                                       |

**Revenue and commission:** revenue 4 500.00 a month; commission 900.00 a month (approved).

|                          | October: circulation 1 (new bottles)                       | November: circulation 2 (refill)                               |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Events                   | filled 5. 10., dispatched 6. 10.                           | crate CC-1 received 3. 11.; refilled 4. 11., dispatched 5. 11. |
| Materials                | 40 × (18.00 + 2.50 + 9.00 + 0.330 × 120.00) = **2 764.00** | 40 × 0.330 × 130.00 = **1 716.00** (no bottle, label or pump)  |
| Outbound                 | 95.00                                                      | 95.00                                                          |
| Return                   | 0.00 (not yet back)                                        | **80.00** (the October crate, at its receipt)                  |
| Commission               | 900.00                                                     | 900.00                                                         |
| Margin before commission | **1 641.00**                                               | **2 609.00**                                                   |
| Margin after commission  | **741.00**                                                 | **1 709.00**                                                   |

Further cases from the same test:

- **The correction:** November recomputed after the 128.00 correction gives materials
  1 689.60 and margin before 2 635.40. Computed with `asOf` 15. 11. it stays 2 609.00.
- **December is incomplete.** Two replacement bottles use a new label variant without a price,
  and the commission is not approved. The margin is not shown, the reasons are listed, and the
  known costs so far are 313.48.
- **Company contrast:** with fictional rent 15 000.00 and accountant 3 000.00, November gives a
  hotel contribution of 1 709.00 and a company result of −16 291.00. These are two different
  figures.

## 8. Questions for the owner (not decided)

1. Margin per hotel or per payer? The invoice is per payer, the overview per hotel (revenue
   lines are per hotel).
2. The month of material costs: the dispatch month (proposal), the fill month or the delivery
   month?
3. A new pump really issued on a refill (a broken one replaced): count it as actual consumption
   (proposal), or never?
4. Is a liquid lost in production (not in a dispatched bottle) a cost of no hotel (proposal) or
   shared?
5. A crate that never comes back: no return cost (proposal). Should a bottle loss carry a cost
   (depreciation, write-off)? This is outside v1.
6. Washing, labour and the washed-pump pool: outside v1 (proposal), or a standard cost per refill?
7. Commission in the overview: approved statements only (proposal), or the preview marked as an
   estimate?
8. Computed on read (proposal) or a frozen monthly snapshot with a fingerprint like the
   commission statement?
9. Where the overview lives: Finance → Přehledy (proposal), or Obchod?

## 9. Not in this batch

- Any Finance or core code, migration or permission (only after approval of ADR 0049 §2).
- Procurement valuation, FIFO or averages.
- Depreciation, overhead allocation, the company result.
- LIVE revenue.
- VAT logic, accounting integration, payments.
