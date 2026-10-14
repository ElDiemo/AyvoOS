# 025 — Stage A: labelling → filling → finished crates (design gate, issue #19)

Status: **Proposal for owner review — the model is not approved, nothing beyond A1 is
implemented** (revision 3, 2026-10-14). PR A1 (physical crates and their QR labels, PR #21) rests
on already approved design (doc 020 §3.4, ADR 0021 §6, doc 022). Every other new table, state,
permission or migration below waits for approval of this document; ADR 0025 (proposed) records
the process decision; doc 026 proposes the next unit A2 (workstations and sessions).

## 0. Confirmed by the owner (2026-10-14) — not asked again

1. **The same physical crate from labelling through filling to dispatch, with two per-bottle
   scans.** At labelling, each bottle is scanned after its label is physically applied and put
   into the selected crate: it becomes a labelled **empty** member of that crate. At filling, the
   same crate is loaded again and each completed bottle is scanned again: the server checks it is
   already an eligible member of **that** crate. The second scan exists to catch bottles a
   previous worker placed wrongly. (Supersedes the "assign only finished bottles" variant of
   revision 2.)
2. **Exact moments of stock consumption:**

   | Step                                                                                          | Stock change                                                                                         |
   | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
   | creating identities / generating the PDF / printing labels                                    | nothing                                                                                              |
   | label physically applied, confirmed by a successful bottle scan into the selected crate       | −1 new bottle body from the chosen source lot + the recipe's label quantity (today 1 pc)             |
   | bottle physically filled and pump installed, confirmed by a successful scan in the SAME crate | −recipe liquid from the explicitly selected current lot (today 330 ml) + recipe pump quantity (1 pc) |
   | Hotovo                                                                                        | nothing further; the crate becomes ready finished stock                                              |
   | allocation of a ready crate to a hotel order (stage C)                                        | no component consumption; reservation/assignment of the finished content                             |
   | dispatch (stage C)                                                                            | the finished crate and its bottles leave the recorded warehouse; no second component deduction       |

   A rejected, replayed or duplicate scan never adds consumption. Breakage, damaged labels,
   spills and count differences are separate audited write-offs/corrections. Historical body
   deductions (today's `LABEL_APPLIED`) stay as they are and are never repeated. The returnable
   crate is not a consumable.

3. The liquid lot may change between bottles of one crate; the switch applies to the following
   bottles only and each bottle keeps the lot actually consumed for it.
4. Two scans are two physical steps, not a rule that two different user accounts must do them.

Not decided by these confirmations (§13): whether labelling binds the bottle to the product /
label design or only to the category; legacy bottles; internal production orders/reservations;
roles; schema and migrations; merge/deploy.

Terminology: **plnění bedny** = production work on one crate cycle; **vychystávání objednávky** =
picking for a hotel order (stage C).

## 1. Process

| Step | Where              | Context chosen once (re-validated by the server on every scan)                                        | Per bottle                                                                   |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | Bedny (A1)         | —                                                                                                     | crates registered, QR labels printed                                         |
| 2    | labelling station  | station QR · source lot of new bottles · product (§13 B1) · crate QR                                  | apply the label → scan → put into the crate = **Potvrdit nalepení**          |
| 3    | handover           | the crate with 40 labelled empties goes to filling (ADR 0021: the 40th member makes it ready to fill) | —                                                                            |
| 4    | filling station    | station QR (mode + category) · the SAME crate QR · liquid lot (switchable between bottles)            | fill, install pump → scan → back into the same crate = **Potvrdit naplnění** |
| 5    | Hotovo             | the crate                                                                                             | server: 40 members, 40 filled, all compatible, no blocker → ready            |
| 6    | Bedny — Připravené | per site                                                                                              | ready crates; dispatch (stage C) accepts only these                          |

The crate QR alone proves nothing about content; the comparison is each bottle's scan against
the recorded membership. Without sensors the system proves neither the poured liquid, nor the
exact amount, nor where a station physically stands (§12).

## 2. Earlier design vs. this revision

| Topic                       | Earlier                                                             | Now                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| assembly (ADR 0021)         | empties scanned into the crate before filling; 40th = READY_TO_FILL | **kept** (owner confirmed the same crate and the scan at labelling)                                                             |
| filling / readiness         | ADR 0021 lists FILLING → FILLED as future                           | the filling scan accepts only members of that crate; **FILLED only by Hotovo** with 40 members all filled — ADR 0025 (proposed) |
| revision 2 (variant B)      | bottles assigned only when finished                                 | **superseded**                                                                                                                  |
| consumption                 | body at activation; label open; liquid/pump "2B"                    | body + label at labelling, liquid + pump at filling (§0.2)                                                                      |
| crate types                 | two                                                                 | one shared `CRATE-40` possible; a cycle stays single-product by its snapshot                                                    |
| production orders (doc 020) | labelling inside released orders with reservations                  | open (§13 B2)                                                                                                                   |

## 3. States

### 3.1 Bottle (`bottles.status`; ADR 0011 unchanged)

```
CREATED ──Potvrdit nalepení (LABEL_APPLIED + ASSIGNED_TO_CRATE)──► LABELED_EMPTY ──Potvrdit naplnění (FILLED)──► FILLED
```

- `FILLED` ("Naplněná – hotová") and event `FILLED` carry the consumed liquid lot. A FILLED bottle
  is never set back to empty; history is never reset.
- Stage A fills only bottles never filled before (`ALREADY_FILLED` otherwise); refilling after
  return and washing is a later approved flow.
- Category binding (doc 020 `bottle_category_bindings`) at labelling, never changed; whether the
  product is bound too: §13 B1. Holds (doc 020 `bottle_holds`) make a bottle ineligible.

### 3.2 Crate cycle — one circulation of one crate (ADR 0021, ADR 0025 proposed)

```
first labelling scan ──► OPEN_ASSEMBLY ──40th member──► READY_TO_FILL ──first Potvrdit naplnění──► FILLING
FILLING ──Hotovo (members = capacity, filled = capacity, no blocker)──► FILLED (Připravená)
READY_TO_FILL ──Vyjmout lahev (supervisor)──► OPEN_ASSEMBLY      FILLING ──Vyjmout lahev──► FILLING (39 members)
FILLED ──Vrátit do rozpracování (supervisor, reason; before ALLOCATED)──► FILLING
OPEN_ASSEMBLY / READY_TO_FILL / FILLING ──Zrušit oběh (supervisor, reason)──► ABORTED
later on the same row: FILLED → ALLOCATED → DISPATCHED → AT_HOTEL → RETURNING → RECEIVED → CLOSED
```

Two separate figures, always shown together: **Obsah n/40** (active members = labelled bottles
in the crate) and **Naplněno m/40** (members that are FILLED). 40/40 with 26/40 filled is
FILLING, not ready; 40/40 labelled empties are READY_TO_FILL, not ready stock. Only Hotovo makes
`FILLED`. A partial crate never becomes READY_TO_FILL manually (ADR 0021 §3).

Derived list state: no open cycle = **Prázdná**; OPEN_ASSEMBLY = **Skládá se (lepení)**;
READY_TO_FILL = **Čeká na plnění**; FILLING = **Plní se**; FILLED = **Připravená**.

### 3.3 Bottles outside a crate

A labelled empty or a finished bottle whose membership was released (crate aborted, bottle
removed) has no active assignment. It keeps its status and is listed per site ("Označené prázdné
mimo bednu", "Hotové lahve mimo bednu"). It returns into a crate only by an explicit operation
(§4.2) — never by a silent move, never with a second consumption.

### 3.4 Workstation session (doc 026)

`ACTIVE → RELEASED | TAKEN_OVER | CLOSED`; lease with heartbeat; expiry releases only station
ownership — never a crate cycle, lot or bottle. Interrupted work stays stored and is resumed by
its owner or taken over by an authorized user (audited); two owners of one station are
impossible.

## 4. Step → scan → event → stock

### 4.1 Normal flow

| Physical step                         | Scan                                      | Records (one transaction, one operation id)                                                                                                                      | Stock                                                                                    |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| print bottle labels                   | existing                                  | print jobs                                                                                                                                                       | none                                                                                     |
| open the labelling context            | station QR, source lot, product, crate QR | session context; crate: new cycle `OPEN_ASSEMBLY` with snapshot (crate type, capacity, product, category, recipe version, label template version) or continue it | none                                                                                     |
| label applied, bottle into the crate  | bottle QR = Potvrdit nalepení             | `LABELED_EMPTY`, `LABEL_APPLIED`, LABEL attachment, binding, assignment (lowest free ordinal), `ASSIGNED_TO_CRATE`; 40th → `READY_TO_FILL`                       | −1 body (session source lot) + label lines of the cycle recipe's `LABEL_APPLICATION` BOM |
| open the filling context              | station QR, crate QR, liquid lot          | session context; the crate must be `READY_TO_FILL`/`FILLING` with category = station category                                                                    | none                                                                                     |
| switch the liquid lot                 | explicit action                           | session event `LIQUID_LOT_CHANGED`                                                                                                                               | none; applies to the following bottles                                                   |
| bottle filled, pump on, back in crate | bottle QR = Potvrdit naplnění             | `FILLED` (+ lot), PUMP attachment; first one → cycle `FILLING`; **no new assignment**                                                                            | −`FILL` BOM lines of the cycle's recipe: liquid from the session's current lot, pump     |
| crate complete                        | Hotovo                                    | cycle `FILLED`, crate event `CRATE_FILLED`, weight snapshot if references exist (§10)                                                                            | none                                                                                     |

Labelling and filling consume the BOMs of the **same recipe version** (the cycle snapshot): a
recipe activated meanwhile never changes an open crate. Finished stock = `FILLED` cycles with
their members, plus finished bottles outside a crate (§3.3) — no second piece-stock in the
ledger.

Optional check scan at either station ("Ověřit"): read-only answer about the scanned bottle; it
never writes. Proposed gesture (UX only): a mode switch Ověřit / Potvrdit, default Potvrdit.

### 4.2 Refusals and exceptions

The normal filling scan **refuses without any write**: a bottle of another crate
(`IN_ANOTHER_CRATE`, naming that crate), a bottle in no crate (`NOT_IN_THIS_CRATE`), another
product/category (`WRONG_PRODUCT` / `WRONG_CATEGORY`), not labelled (`BOTTLE_NOT_LABELED`),
already filled (`ALREADY_FILLED`), on hold (`BOTTLE_ON_HOLD`), another site
(`BOTTLE_OF_ANOTHER_SITE`). There is **no silent reassignment**.

| Situation                                        | Operation (separate, authorized, reason, audited)                                                                                                           | Stock                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| a labelled empty bottle is in the wrong crate    | **Přeřadit lahev**: release from crate X, assign to crate Y (same snapshot, free ordinal); states recomputed (READY_TO_FILL → OPEN_ASSEMBLY below capacity) | none                                                               |
| damaged / missing bottle in a crate              | **Vyjmout lahev**: release membership, `REMOVED_FROM_CRATE`; damaged → hold `QUARANTINED`; a filled one keeps FILLED                                        | none; a broken body is written off by the separate scrap operation |
| a crate in FILLING lost a member                 | **Doplnit lahev**: a labelled empty with the same snapshot into the free ordinal                                                                            | none                                                               |
| defect found in a ready crate                    | **Vrátit do rozpracování** → FILLING (before `ALLOCATED`), then Vyjmout/Doplnit                                                                             | none                                                               |
| restart a crate                                  | **Zrušit oběh**: every membership released one by one; bottles keep their status, outside a crate; cycle `ABORTED`                                          | none — nothing returned to stock, nothing re-emptied               |
| bottle outside a crate                           | **Vrátit lahev do bedny** (repack): into an open cycle with the same snapshot; a filled bottle only into READY_TO_FILL/FILLING                              | **none**, never a second consumption                               |
| breakage, damaged label, spill, count difference | scrap / write-off / inventory correction (§8), audited                                                                                                      | own movement type, never a hidden recipe increase                  |

Every exception re-checks site, snapshot and holds; a refusal writes nothing.

## 5. Proposed models (approval required except A1)

| Table                                            | Purpose and key rules                                                                                                                                             | Basis              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A1 tables                                        | `qr_identities`, `crate_registrations`, `crates`, crate label print jobs, `crate_events` (PR #21)                                                                 | doc 020            |
| `workstations`, `workstation_sessions` (+events) | doc 026 (A2)                                                                                                                                                      | **new**            |
| `crate_cycles`                                   | doc 020 §3.4 states + `FILLING`, `FILLED`; snapshot incl. recipe version; counters `member_count`, `filled_count` (current state, changed only with their events) | doc 020 + ADR 0025 |
| `crate_assignments`                              | doc 020 §3.4; source `LABELING` / `REASSIGNED` / `REPACKED` / `REPLACEMENT`; one active assignment per bottle                                                     | doc 020            |
| `bottle_category_bindings`                       | doc 020 §3.5 (+ product if §13 B1)                                                                                                                                | doc 020            |
| `bottle_holds`                                   | doc 020 §3.5                                                                                                                                                      | doc 020            |
| weight tables                                    | §10 (PR W1)                                                                                                                                                       | **new**            |
| enums                                            | bottle status `FILLED`; events `FILLED`, `ASSIGNED_TO_CRATE`, `REMOVED_FROM_CRATE`, `REASSIGNED`, `REPACKED`, `QUARANTINED`; movement type `FILL`                 | new values         |

## 6. Invariants and server rules

Scans carry `{requestId, sessionId, scannedValue}`; station, mode, category, product, recipe
snapshot, lots, crate and site come from the session and are re-validated on every scan. Lock
order (doc 020 §8): operation request → session → crate → cycle → bottle → balances.

| Invariant                                                                                               | Enforcement                                                                                   |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| never more than capacity members                                                                        | `CHECK ordinal BETWEEN 1 AND cycle_capacity`; partial unique (cycle, ordinal) of active ones  |
| a bottle in at most one active cycle                                                                    | partial unique on active assignments                                                          |
| `READY_TO_FILL` ⇔ members = capacity and none filled; `OPEN_ASSEMBLY` ⇒ members < capacity, none filled | commit-time trigger                                                                           |
| `FILLING` ⇒ ≥ 1 filled member; 40/40 members and even 40/40 filled are still not ready                  | readiness is never derived from counts                                                        |
| `FILLED` ⇒ members = filled = capacity, all hold-free and matching the snapshot                         | commit-time trigger                                                                           |
| `FILLING → FILLED` only by Hotovo                                                                       | transition trigger requires a `CRATE_FILLED` event of the same operation                      |
| the filling scan never assigns                                                                          | a `FILLED` event requires an existing active assignment of the bottle in the session's cycle  |
| body + label consumed exactly once                                                                      | one `LABEL_APPLIED` per bottle (existing) + its `LABEL_APPLICATION` movements reference it    |
| liquid + pump consumed exactly once                                                                     | one `FILLED` event per bottle (stage A) + `FILL` movements reference it (unique per BOM line) |
| the bottle keeps its liquid lot                                                                         | the `FILLED` event and its liquid movement name the same lot                                  |
| counters ⇔ assignments and events                                                                       | commit-time check                                                                             |

Retries and races: same request id → stored result; a new request id for a step already done →
`ALREADY_APPLIED` / `ALREADY_FILLED` under the bottle lock, no write; two Hotovo → the cycle lock.

**Tests (A3/A4):** a foreign bottle from another crate refused at filling, no stock change; double
scan at each station, one consumption each; body + label exactly once and liquid + pump exactly
once per bottle; 40 labelled / 0 filled not ready; 40 / 26 not ready; 39/40 Hotovo refused;
40/40 after Hotovo ready; 41st member refused; lot switch after 23/40 with exact lots; abort →
bottles outside crates, stock unchanged, repack without consumption; takeover/resume; wrong
category/site; a recipe activated during an open crate.

## 7. Permissions (proposal, §13 B4; ADMIN by migration, doc 021)

| Permission                                                                                | PROD. OPERATOR | PROD. SUPERVISOR | WH. OPERATOR | WH. SUPERVISOR | ADMIN |
| ----------------------------------------------------------------------------------------- | :------------: | :--------------: | :----------: | :------------: | :---: |
| `crates:read` / `crates:register` (A1)                                                    |      read      |        ✓         |     read     |       ✓        |   ✓   |
| `production:workstations_manage` (new)                                                    |                |        ✓         |              |                |   ✓   |
| `production:label_apply` (exists; labelling station)                                      |       ✓        |        ✓         |              |                |   ✓   |
| `production:fill` (new; filling station, lot switch, Hotovo)                              |       ✓        |        ✓         |              |                |   ✓   |
| `production:cycle_correct` (new; Přeřadit, Vyjmout, Doplnit, Vrátit, Zrušit oběh, repack) |                |        ✓         |              |                |   ✓   |
| `production:session_takeover` (doc 020)                                                   |                |        ✓         |              |                |   ✓   |
| `catalog:weights_record` (new, W1)                                                        |                |        ✓         |              |       ✓        |   ✓   |

## 8. Inventory counting (separate follow-up)

Recorded vs. counted stock, difference, audited correction (append-only ledger), separate from
production consumption and spoilage; counts carry a cut-off and refuse a stale correction; liquid
kg ↔ ml only with an approved method/density. Stage A consumes exact recipe quantities.

## 9. Later stages this design must not block

- **Orders (B) / dispatch (C):** order numbers, lines with requested/prepared/dispatched pieces and
  crates; idempotent plan generation; one scan of a ready crate allocates its exact members as
  historical links; allocation ≠ dispatch; a scrapped allocated bottle releases it in the same
  transaction and blocks dispatch (39/40); dispatched content is never rewritten.
- **Returns:** a crate scan records only the crate; bottles are identified one by one
  (mixed/partial returns); missing bottles stay "not returned"; a return or the crate's next cycle
  never rewrites a dispatched cycle's content; washing/refill eligibility are real operations
  (criteria open).

## 10. Weights (PR W1; nothing invented, no seeded values)

W1 delivers **all** of: reference weights of the individual components (bottle body, pump,
label; a liquid as the measured mass of a stated volume), the **measured weight of one finished
bottle** per product, the **crate tare** with dividers, and historical snapshots. Every value may
be unknown until measured — unknown is never 0 and never estimated.

| Record (append-only, audited) | Content                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `item_reference_weights`      | per component: g per piece, or for a liquid the weighed mass of a stated volume; measured_at/by, method |
| `product_reference_weights`   | finished bottle (body + content + pump + label) in g; measured_at/by, method, bottles weighed           |
| `crate_type_tare_weights`     | empty crate with dividers in g; configuration; measured_at/by                                           |
| snapshots                     | Hotovo stores the reference rows used; dispatch snapshots again; corrections never rewrite them         |
| actual weighings (stage C)    | a concrete crate/shipment: who, when, scale/tare conditions — apart from expected values                |

- **Expected full crate** = filled bottles × finished-bottle reference + crate tare (+ only
  packaging not in the tare). Components are shown beside it as a cross-check sum (unknown parts
  named), never added on top: no double counting.
- Units stored in g, displayed in kg where useful; 330 ml is not 330 g; a weighed liquid sample
  needs no density; converting stock kg ↔ ml does (§8). Recording weights never changes stock
  units, never creates stock or consumption, never unlocks an active recipe.
- Tests: exact sums, conversions, unknown parts, no double counting, snapshot preserved after a
  correction, permissions, origin.

## 11. PR split

| PR     | Content                                                                                                | Gate                  |
| ------ | ------------------------------------------------------------------------------------------------------ | --------------------- |
| A0     | this document, ADR 0025 (proposed), doc 026                                                            | owner review          |
| **A1** | physical crates, QR registry, crate labels (PR #21)                                                    | technical review done |
| A2     | workstations, station QR, sessions (doc 026)                                                           | model approval + B4   |
| A3     | labelling station: context, Potvrdit nalepení into the crate, body + label consumption, binding        | approval + B1, B2, B3 |
| A4     | filling station: same crate, Potvrdit naplnění, liquid + pump, lot switch, Hotovo, exceptions §4.2     | approval + B5         |
| A5     | Bedny: states with both counts, ready crates and bottles outside crates per site; full Playwright flow | after A4              |
| W1     | all weights (§10)                                                                                      | approval + B6         |
| later  | inventory (§8), orders/dispatch/exports/hotel history (§9), returns, Quality                           | own designs           |

## 12. Honest limits

- No scan proves the poured liquid, the exact amount or a station's physical position. A wrong
  liquid is not detected by software; mitigation: station signage, the liquid lot chosen
  explicitly and shown permanently, separate physical stocks. No sensor or hardware lock exists.
- The crate QR does not prove content; each bottle's second scan is compared with the recorded
  membership.
- Crate and bottle locations are the last recorded ones, not sensed positions.
- Weights are references/expectations unless a concrete weighing is recorded.

## 13. Owner decisions (2026-10-14) — resolved

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Used by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| B1  | Labelling binds the bottle to the concrete **product** through an approved label design. A normal scan never changes the binding; a future relabelling is a separate controlled procedure.                                                                                                                                                                                                                                                                                                                                                                                     | A3      |
| B2  | No internal production orders or material reservations in stage A. Product and recipe version are stored on the crate cycle and never change by themselves while it is in progress. Material availability is checked at every confirmation.                                                                                                                                                                                                                                                                                                                                    | A3, A4  |
| B3  | Historical labelled bottles without the required binding are refused at filling with an explanation. Nothing is deleted, relabelled automatically or consumed again; a later controlled completion of bindings is separate.                                                                                                                                                                                                                                                                                                                                                    | A3, A4  |
| B4  | Role matrix §7 approved: production operator — labelling, filling, lot switch between bottles, Hotovo; production supervisor and ADMIN additionally station management, crate corrections and forced takeover; weights — production supervisor, warehouse supervisor, ADMIN. All permissions respect the assigned sites and warehouses. A **voluntary handover** of a crate in progress to another authorized operator needs no supervisor; a **forced takeover** of an occupied station does. A crate in progress and its history are kept independently of any user session. | A2–A4   |
| B5  | One bottle has exactly one liquid lot; a lot switch applies from the next bottle. Actual mixing is an exception to resolve, never a reason to record an untrue lot.                                                                                                                                                                                                                                                                                                                                                                                                            | A4      |
| B6  | A reference weight does not block Hotovo; an unmeasured value is "neznámá", never 0. This does not approve dispatch through a carrier (PPL) without the required transport data.                                                                                                                                                                                                                                                                                                                                                                                               | W1      |

Still open, lower priority: crate label size (entered per print job until a test print is
approved) and the public crate page text (neutral until a contact is approved).

Later stages noted by the owner (not part of A2): receiving by supplier barcodes with controlled
barcode aliases per item and package (a barcode is not a lot; a lot-tracking change of the pump
needs its own design), mobile dispatch with PPL (sandbox first; picking done ≠ label created ≠
handed over ≠ delivered; retries never create a duplicate shipment), orders and returns.
