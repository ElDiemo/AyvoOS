# 025 — Stage A: labelling → filling → finished crates (design gate, issue #19)

Status: **Proposal for owner review — not approved, not implemented** (revision 2,
2026-10-14). Only §11 PR A1 (physical crates and their QR labels, PR #21) rests on already
approved design (doc 020 §3.4, ADR 0021 §6, doc 022). Every other new table, state, permission
or consumption change below waits for the owner's approval of this document and the answers in
§13.

**Confirmed by the owner (2026-10-14), not asked again:** station QR once → crate QR → scan of
each **finished** (filled and completed) bottle → explicit **Hotovo**. Labelling is a separate,
earlier station. The liquid lot may change between bottles of one crate.

Builds on docs 016, 018, 020, 022, 023 and ADR 0006, 0011, 0014, 0019, 0021. Production to stock
is independent of hotel orders; hotels, plans, orders and dispatch (stages B–D), returns,
washing, inventory counting and weights are designed here only as far as stage A must not block
them (§8–§10).

Terminology: **plnění bedny** (filling work on one crate cycle) is never called "objednávka";
**vychystávání objednávky** (picking for a hotel order) is stage C.

## 1. Physical process supported in stage A

1. **Crates** — physical returnable crates are registered and get a permanent QR label (A1).
2. **Labelling station** — labels are printed, then applied to empty bottle bodies. Printing
   proves nothing physical; the confirmed application ("Potvrdit nalepení") makes the bottle a
   labelled empty bottle that can be handed to filling.
3. **Filling station** (one per category; several may run in parallel) — station QR once, then
   the crate QR opens or continues the crate's filling; each bottle is scanned only **after** it
   is filled and completed ("Potvrdit hotovou lahev"): one finished bottle, its assignment to the
   crate and its one-time FILL consumption. No mandatory pre-scan.
4. **Hotovo** — the only way a crate becomes ready: the server checks exactly the snapshotted
   capacity of compatible finished bottles and no blocker, then marks it ready atomically.
   40/40 without Hotovo is **not** ready.
5. **Ready crates** — a filtered view of the same crate records per site; dispatch (stage C)
   accepts only these.

## 2. Earlier design vs. the owner's latest statements

| #   | Earlier design                                                                            | Owner (2026-10-14)                                        | Resolution                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ADR 0021: empty bottles assembled into the crate before filling; 40th = ready             | crate first, finished bottles scanned in, explicit Hotovo | **Confirmed.** ADR 0025 (written with the A4 PR) supersedes ADR 0021 §2–3 for assembly order and readiness; capacity as data, one cycle = one circulation, snapshots, ordinals stay. |
| 2   | Label application consumes one `NEW_BOTTLE`; recipe puts the label in `LABEL_APPLICATION` | material follows the physical step                        | Body at labelling (unchanged), liquid + pump at the finished-bottle scan; nothing twice. Label stock timing = owner decision (§13 O1).                                               |
| 3   | Two crate types                                                                           | one shared `CRATE-40`                                     | Already possible (doc 023); a cycle stays single-product by its snapshot.                                                                                                            |
| 4   | Doc 020 v0.1 excludes filling                                                             | stage A fills                                             | This document is the extension.                                                                                                                                                      |
| 5   | Doc 020 labelling inside production orders with reservations                              | production to stock                                       | Production to stock does **not** by itself rule out internal orders: owner decision (§13 O3).                                                                                        |

## 3. States

### 3.1 Bottle (`bottles.status`, ADR 0011 unchanged)

```
CREATED ──Potvrdit nalepení (LABEL_APPLIED)──► LABELED_EMPTY ──Potvrdit hotovou lahev (FILLED)──► FILLED
```

- New status `FILLED` ("Naplněná – hotová") and event `FILLED` carrying the consumed liquid lot.
  A FILLED bottle is **never** set back to empty; its history is never reset.
- **First fill only** in stage A: a bottle with a `FILLED` event is refused at the fill scan
  (`ALREADY_FILLED`); refilling after return/washing is a later, approved flow.
- **Category binding** (doc 020 `bottle_category_bindings`) once at labelling (product binding:
  §13 O2), never changed. Bottles labelled before this change: §13 O4.
- Holds (doc 020 `bottle_holds`) make a bottle ineligible for assignment, Hotovo and dispatch.

### 3.2 Crate cycle (`crate_cycles.status`; crate lifetime is separate)

```
(crate QR at a filling station) ──► FILLING ──Hotovo (active = capacity, all compatible)──► FILLED
FILLED ──Vrátit do rozpracování (supervisor, reason; before ALLOCATED)──► FILLING
FILLING ──Zrušit plnění bedny (supervisor, reason)──► ABORTED
```

- `FILLING` holds 0…capacity finished bottles; **40/40 is still FILLING** until Hotovo.
- `FILLED` = ready finished stock ("Připravená"). Later on the same row: `ALLOCATED →
DISPATCHED → AT_HOTEL → RETURNING → RECEIVED → CLOSED` (ADR 0021).
- At most one open cycle per crate; only `ABORTED`/`CLOSED` free it.
- Crate list state is derived: no open cycle = **Prázdná**, `FILLING` = **Rozpracovaná n/40**,
  `FILLED` = **Připravená**.

### 3.3 Finished bottles outside a crate

A finished bottle whose assignment was released (crate aborted, bottle removed for repacking)
stays `FILLED` with **no active assignment**: it is finished stock **outside a crate** and is
listed as such per site ("Hotové lahve mimo bednu"). It can only be **repacked** (§4.2) — never
filled again, never counted as empty, never dispatched without a crate.

### 3.4 Workstation session

```
ACTIVE ──release / station change──► RELEASED      ACTIVE ──takeover (authorized, reason)──► TAKEN_OVER
```

Lease 15 min (configuration, doc 020 §6). Expiry releases only station ownership — never a crate
cycle, a lot or a bottle. Interrupted work stays stored: the same user resumes, another
authorized user takes over (audited); two owners of one crate are impossible (partial unique).

## 4. Step → scan → event → stock matrix

### 4.1 Normal flow

| Physical step                   | Scan / confirmation             | Records (one transaction, one operation id)                                                             | Stock movement                                                       |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Register crates / print QR (A1) | form                            | registration, crates, QR registry, crate events                                                         | none                                                                 |
| Print bottle labels             | existing                        | existing print jobs                                                                                     | none (O1)                                                            |
| Label applied to an empty body  | bottle QR = Potvrdit nalepení   | `LABELED_EMPTY`, `LABEL_APPLIED`, LABEL attachment, category binding                                    | −1 `NEW_BOTTLE` from the selected lot (existing); label stock per O1 |
| Open filling station            | station QR, product, liquid lot | session (station, product + recipe-version snapshot, liquid lot)                                        | none                                                                 |
| Change liquid lot               | explicit action at the station  | session event `LIQUID_LOT_CHANGED` (from, to)                                                           | none — applies only to the **following** confirmed bottles           |
| Start / continue a crate        | crate QR                        | new cycle `FILLING` with snapshot (crate type, capacity, product, category, recipe version) or continue | none                                                                 |
| Check a bottle (optional)       | bottle QR in "Ověřit" mode      | nothing (read-only answer: right product/category or not)                                               | none                                                                 |
| Bottle filled and completed     | bottle QR = Potvrdit hotovou    | `FILLED` (+ liquid lot), PUMP attachment, assignment (lowest free ordinal), `ASSIGNED_TO_CRATE`         | −recipe liquid from **the session's current lot**, −1 pump           |
| Crate complete                  | **Hotovo**                      | cycle `FILLED`, crate event `CRATE_FILLED`, weight snapshot (§10) if a reference exists                 | none                                                                 |

The finished-goods stock is the `FILLED` crate cycles with their assignments plus the finished
bottles outside a crate (§3.3) — no second piece-stock of filled bottles in the ledger.

The optional check scan only tells whether the **labelled bottle** matches the station; it never
writes and cannot detect which liquid is poured later (§12). The required confirmation scan comes
after filling and therefore detects a wrong bottle only after pouring (owner accepted). Proposed
gesture (UX, not a new mandatory scan): one large mode switch **Ověřit / Potvrdit hotovou**,
default Potvrdit hotovou.

### 4.2 Exceptions (supervised, audited, never a free status edit or DELETE)

| Situation                                        | Operation                                                                                                                                                                                                      | Stock                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Wrong/damaged finished bottle in a FILLING crate | **Vyjmout lahev** (supervisor, reason): release assignment, `REMOVED_FROM_CRATE`; damaged → open hold (`QUARANTINED`); good → finished bottle outside a crate                                                  | none — the FILL consumption stays history               |
| Defect found in a FILLED (ready) crate           | **Vrátit do rozpracování** (supervisor, reason) → `FILLING`, then Vyjmout lahev; refused once `ALLOCATED` (stage C defines removal from picked orders: 39/40 is never dispatchable)                            | none                                                    |
| Stop / restart a crate's filling                 | **Zrušit plnění bedny** (supervisor, reason): every assignment released one by one (`REMOVED_FROM_CRATE`), cycle `ABORTED`; finished bottles stay `FILLED` outside a crate; the crate starts a new cycle later | none — nothing is returned to stock, nothing re-emptied |
| Finished bottle outside a crate                  | **Přeložit hotovou lahev** (explicit mode at a filling station): assigns it to an open `FILLING` cycle whose snapshot (product, category, recipe version) matches; event `REPACKED`                            | **none** — never a second liquid/pump consumption       |
| Scrap a bottle / remove an installed pump        | later Quality/repair flows (RETIRED vs DISPOSED/DESTROYED per ADR 0011; removed pump = attachment end, never a second new-pump consumption)                                                                    | per the later design                                    |

Who may repack: §13 O6. A single bottle filled from two liquid lots (refilling the tank): §13 O5.

## 5. Proposed models (new — approval required except A1)

| Table                               | Purpose and key rules                                                                                                                                       | Basis              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A1 tables                           | `qr_identities`, `crate_registrations`, `crates`, crate label print jobs, `crate_events` (PR #21)                                                           | doc 020            |
| `workstations`                      | code, name, site, warehouse, **mode** `LABELING`/`FILLING`, category (FILLING), status, QR token (registry kind `WORKSTATION`)                              | **new**            |
| `workstation_sessions` (+events)    | user, station, lease, product + recipe-version snapshot, current liquid lot, current cycle; one active session per crate and per user (partial unique)      | doc 020 §6 adapted |
| `crate_cycles`, `crate_assignments` | doc 020 §3.4 with §3.2 states; assignment source `FILL` or `REPACK`                                                                                         | doc 020            |
| `bottle_category_bindings`          | doc 020 §3.5 (+ product, O2)                                                                                                                                | doc 020            |
| `bottle_holds`                      | doc 020 §3.5                                                                                                                                                | doc 020            |
| `product_label_approvals`           | label template version ↔ product (doc 020 §3.3), if O2 = product binding                                                                                    | doc 020            |
| weight tables (§10)                 | append-only reference measurements + snapshots                                                                                                              | **new**, later PR  |
| enums                               | bottle status `FILLED`; bottle events `FILLED`, `ASSIGNED_TO_CRATE`, `REMOVED_FROM_CRATE`, `REPACKED`, `QUARANTINED`; movement type `FILL`; operation kinds | new values         |

A station is a **work mode at a site**, never a site or warehouse. Its QR names the station only:
not a login, permission or secret. Public QR pages: station → "Interní označení AYVO"; crate →
"Returnable AYVO crate" (A1).

## 6. Server rules and database invariants

Requests carry only `{requestId, sessionId, scannedValue}`; station, mode, category, product,
recipe snapshot, liquid lot, crate and site come from the session. Lock order (doc 020 §8):
operation request → session → crate → cycle → bottle → balances.

Refusals (Czech text + sound + visible state; scanner keeps focus), without any write:
`STATION_INACTIVE`, `STATION_OF_ANOTHER_SITE`, `SESSION_NOT_OWNED`, `WRONG_STATION_MODE`,
`WRONG_CATEGORY`, `PRODUCT_MISMATCH`, `BOTTLE_NOT_LABELED`, `ALREADY_FILLED`, `BOTTLE_ON_HOLD`,
`BOTTLE_OF_ANOTHER_SITE`, `IN_ANOTHER_CRATE`, `CRATE_FULL` (41st), `CRATE_IN_USE`,
`CRATE_NOT_FILLING`, `LOT_EXHAUSTED`, `LOT_NOT_ALLOWED` (wrong item/site), `INSUFFICIENT_STOCK`
(pump), `CRATE_INCOMPLETE` (Hotovo below capacity), `REPACK_INCOMPATIBLE`. A newer recipe version
never switches an open cycle; only a new cycle takes the then active version.

| Invariant                                                                                         | Enforcement                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| never more than capacity                                                                          | `CHECK ordinal BETWEEN 1 AND cycle_capacity`, partial unique (cycle, ordinal) of active assignments         |
| `FILLING` may hold 0…capacity (40/40 allowed, **not** ready)                                      | no lower bound on FILLING; readiness is not derived from the count                                          |
| `FILLED` ⇒ active assignments = capacity, each a `FILLED`, hold-free bottle matching the snapshot | commit-time constraint trigger on cycles and assignments                                                    |
| readiness only by Hotovo                                                                          | transition trigger: `FILLING → FILLED` only with a `CRATE_FILLED` crate event of the same operation         |
| assignments only into `FILLING`                                                                   | insert trigger                                                                                              |
| a bottle in at most one active cycle                                                              | partial unique `crate_assignments(bottle_id) WHERE released_at IS NULL`                                     |
| one `FILLED` event per bottle (stage A)                                                           | partial unique on bottle events                                                                             |
| FILL consumption exactly once                                                                     | each `FILL` movement references the `FILLED` event (unique per item); `REPACK` assignments have no movement |
| the bottle keeps its lot                                                                          | `FILLED` event and its liquid movement name the same lot (commit-time)                                      |
| no assignment while on hold                                                                       | guard + commit-time check                                                                                   |

Concurrency and retries: same request id → stored result; another request id for a finished
bottle → `ALREADY_FILLED` under the bottle lock; two stations → the crate's session; two Hotovo →
the cycle lock (second gets the stored state); a scan racing Hotovo → the cycle lock decides.

**Tests (A4):** 39/40 Hotovo refused; 40/40 before Hotovo not ready (not in ready list, not
dispatchable); 40/40 after Hotovo ready; 41st scan refused; lot switch after 23/40 → bottles
1–23 lot X, 24–40 lot Y, exact movements; abort of a partial crate → bottles FILLED outside a
crate, stock unchanged, no second consumption on repack; takeover and resume; wrong category;
retries/races; Vrátit do rozpracování.

## 7. Permissions (proposal; ADMIN granted by migration, doc 021) — §13 O7

| Permission                                                                       | PROD. OPERATOR | PROD. SUPERVISOR | WH. OPERATOR | WH. SUPERVISOR | ADMIN |
| -------------------------------------------------------------------------------- | :------------: | :--------------: | :----------: | :------------: | :---: |
| `crates:read` (A1)                                                               |       ✓        |        ✓         |      ✓       |       ✓        |   ✓   |
| `crates:register` + crate labels (A1)                                            |                |        ✓         |              |       ✓        |   ✓   |
| `production:workstations_manage` (new)                                           |                |        ✓         |              |                |   ✓   |
| `production:label_apply` (exists, at a station)                                  |       ✓        |        ✓         |              |                |   ✓   |
| `production:fill` (new: crate, finished scan, lot change, Hotovo, repack)        |       ✓        |        ✓         |              |                |   ✓   |
| `production:cycle_correct` (new: Vyjmout, Vrátit do rozpracování, Zrušit plnění) |                |        ✓         |              |                |   ✓   |
| `production:session_takeover` (doc 020)                                          |                |        ✓         |              |                |   ✓   |
| `catalog:weights_record` (new, §10)                                              |                |        ✓         |              |       ✓        |   ✓   |

## 8. Inventory counting (separate follow-up, not stage A)

A separate **Inventura** section: recorded stock vs. physically counted stock, difference, and an
audited correction movement (append-only ledger, never a balance overwrite), distinct from
production consumption and from spoilage. Count snapshots carry their cut-off time; a confirmation
re-checks movements after the cut-off and refuses a stale correction. Liquids: counted in their
base unit (ml); a mass-to-volume conversion needs an approved method/density — never kg minus ml.
Stage A consumes exact recipe quantities; history is never recalculated.

## 9. Later stages this design must not block

- **Orders (B) and dispatch (C):** human order numbers, hotel, date, state and lines
  (requested/prepared/dispatched pieces and crates); generation from plans idempotent by a
  business key; one scan of a `FILLED` crate allocates its exact assignments (historical links);
  allocation ≠ dispatch; a bottle scrapped while allocated releases it in the same transaction,
  shows the shortage and blocks dispatch (39/40); dispatched content is never rewritten;
  cancelling picking never touches production. Export and hotel history (plan / ordered /
  dispatched / delivered / returned kept apart; no consumption claimed) and the later hotel
  portal with only own data — stages B–D.
- **Returns:** a crate scan records only the crate; bottles are identified one by one; missing
  bottles stay "not returned"; a bottle returned in another crate never rewrites dispatch history;
  washing and refill eligibility are real operations (doc 009, criteria open).

## 10. Weights (separate PR after A4; nothing invented, no seeded values)

The owner's latest clarification is primary: the **measured reference weight of one finished
bottle** (bottle + content + pump + label) per product is the basic source; component weights are
complementary, never a prerequisite.

| Record (append-only, audited)              | Content                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_reference_weights`                | product, gross weight in **g** (`NUMERIC(19,3)`), measured_at, measured_by, method/conditions note, number of bottles weighed; a correction is a new row      |
| `crate_type_tare_weights`                  | crate type, tare in g of the empty crate **including its dividers**, configuration description, measured_at/by                                                |
| `item_reference_weights` (optional, later) | component weight per piece (bottle, pump, label) — liquids only with a documented density; never used together with the finished-bottle reference for one sum |
| snapshots                                  | at Hotovo the crate cycle stores the reference-weight row ids used; dispatch (C) snapshots again; later corrections never rewrite them                        |
| actual weighings (stage C)                 | a concrete crate/shipment weighed: who, when, scale/tare conditions — kept apart from expected values                                                         |

- **Expected full crate** = finished bottles × product reference weight + crate tare (+ only
  packaging not already in the tare). Shown as _expected/calculated_, never as weighed. If any
  input is unknown the result is unknown — never 0, never estimated.
- Units: stored in g, displayed in kg where useful, exact decimal conversion; 330 ml is never
  330 g; recording a weight never changes an item's stock unit and never creates stock or
  consumption; it never unlocks editing an active recipe.
- Primary UX: product detail → **Referenční hmotnost hotové lahve** (value, unit, date, author,
  history); crate type → **Tára prázdné bedny s přepážkami**. Carrier (e.g. PPL) limits and
  formats are verified only at integration. Weighing never replaces scanning identities; no
  tolerance or blocking is proposed (owner, open).
- Tests: exact sums, unit conversion, unknown values, no double counting (finished bottle vs.
  components, tare vs. dividers), snapshot unchanged after a correction, permissions, origin.

## 11. PR split

| PR     | Content                                                                                                                          | Gate                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A0     | this document                                                                                                                    | owner review          |
| **A1** | physical crates, QR registry, crate labels (PR #21)                                                                              | doc 020 — in review   |
| A2     | workstations + station QR + server-side sessions (lease, resume, release, takeover)                                              | approval + O7         |
| A3     | labelling at a station with category/product binding (+ label stock if O1)                                                       | approval + O1, O2, O4 |
| A4     | filling: cycles `FILLING`/`FILLED`, finished-bottle scan with FILL consumption and lot switch, Hotovo, exceptions §4.2, ADR 0025 | approval + O3, O5, O6 |
| A5     | Bedny overview of ready crates and finished bottles outside crates per site; full Playwright flow labelling → filling → ready    | after A4              |
| W1     | reference weights of finished bottles and crate tares, expected crate weight, snapshot at Hotovo                                 | approval + O8         |
| later  | inventory counting (§8), orders/dispatch/exports/hotel history (§9), returns, Quality                                            | own designs           |

## 12. Honest limits

- The station scan does not prove which liquid a person poured or where the station stands; a
  wrong liquid is not detected by software before pouring. Mitigation: visible station signage,
  the liquid lot chosen explicitly and shown permanently, physically separate liquid stocks. No
  sensor or hardware lock exists.
- A wrongly labelled bottle is detected at its finished scan, i.e. after filling (accepted); the
  optional check scan reduces this.
- Crate location is the last recorded location only; registration records the site, not a
  warehouse.
- Weights are references and expectations unless a concrete weighing is recorded.

## 13. Owner decisions still open (one list; recommendation and impact)

1. **O1 — label stock:** consumed at application (one per bottle at Potvrdit nalepení), at
   printing, or not tracked? _Recommendation:_ at application. _Impact:_ stock matches labelled
   bottles; misprints need a separate write-off.
2. **O2 — what labelling binds:** category only, or the product (label design approved for exactly
   one product)? _Recommendation:_ product. _Impact:_ the filling station can refuse a wrong
   bottle before pouring; needs label-design approval per product.
3. **O3 — internal production orders/reservations in stage A:** _Recommendation:_ none in A;
   product + recipe chosen at the session and snapshotted on the crate. _Impact:_ no material
   reservation (availability checked at each scan); planning comes later.
4. **O4 — bottles labelled before this change (no binding):** _Recommendation:_ refuse at
   filling. _Impact:_ none on DEV data; a supervised one-time binding would need its own audit
   rules.
5. **O5 — one bottle filled from two liquid lots** (tank refilled mid-bottle): _Recommendation:_
   not supported — the lot switch takes effect before the next bottle; operators finish a bottle
   from one lot. _Impact:_ lot traceability stays exact; a mixed bottle would need a separate rule.
6. **O6 — who may repack a finished bottle outside a crate:** _Recommendation:_ operator in the
   explicit "Přeložit" mode; removal, Vrátit do rozpracování and Zrušit plnění only supervisor.
   _Impact:_ fast repacking without supervisor, corrections stay controlled.
7. **O7 — permission matrix §7:** _Recommendation:_ as proposed. _Impact:_ new permissions
   `production:fill`, `production:cycle_correct`, `production:workstations_manage`,
   `catalog:weights_record`.
8. **O8 — reference weight before Hotovo:** required or optional? _Recommendation:_ optional; the
   expected crate weight shows "neznámá" until measured. _Impact:_ filling is not blocked by
   missing measurements.
9. **O9 — crate label size** (A1): _Recommendation:_ entered per print job until a test print is
   approved. _Impact:_ none on data.
10. **O10 — public crate page text/contact** (A1): _Recommendation:_ keep the neutral "Property of
    AYVO. This crate is reused." until a contact/return instruction is approved.
