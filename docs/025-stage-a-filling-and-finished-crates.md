# 025 — Stage A: labelling → filling → finished crates (design gate, issue #19)

Status: **Proposal for owner review — not approved, not implemented** (2026-10-14). Only §9 PR
A1 (physical crates and their QR labels) rests on already approved design (doc 020 §3.4, ADR
0021 §6, doc 022) and may be implemented before this gate closes. Every other new table, state,
permission or consumption change below waits for the owner's approval of this document and the
answers in §11.

Builds on docs 016, 018, 020, 022, 023 and ADR 0006, 0011, 0014, 0019, 0021. Production to stock
is independent of hotel orders (owner, 2026-10-14); hotels, plans, orders and dispatch (stages
B–D) and returns/washing are designed only far enough that stage A does not have to be rewritten
for them (§8).

## 1. Physical process supported in stage A (owner, 2026-10-14)

1. **Crates** — physical returnable crates are registered and get a permanent QR label.
2. **Labelling station** — labels are printed, then applied to empty bottle bodies. Printing
   proves nothing physical. The confirmed application makes the bottle a **labelled empty
   bottle** that can be handed to filling.
3. **Filling station** (one per category, e.g. hand soap, shower gel; may run in parallel) — the
   operator scans the **station QR** once, then the **crate QR** to open or continue the crate's
   filling, then scans each bottle **only after** it is filled and completed. That scan is the
   explicit confirmation of one finished bottle, its assignment to the crate and its one-time
   material consumption. There is no mandatory pre-scan before filling.
4. **Hotovo / Dokončit bednu** — the server checks the crate is full to its snapshotted capacity
   with compatible, finished bottles and marks it **ready** atomically. 40/40 without Hotovo is
   not ready.
5. **Ready crates** — a filtered view of the same crate records per site; dispatch (stage C) will
   accept only these.

Labelling and filling are two independent confirmations with a traceable hand-over (the bottle
state); no single scan ever claims both.

## 2. Conflicts with earlier design and how this proposal resolves them

| #   | Earlier design                                                                            | Latest owner statement                                                | Proposal                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ADR 0021 / doc 020: empty bottles are scanned into the crate **before** filling           | "Bedna na začátku, scan HOTOVÝCH lahví" (marked as taking precedence) | Variant **B**: bottles are assigned to the crate **when finished**. A new ADR 0025 supersedes ADR 0021 §2–3 for the assembly order only (capacity as data, one cycle = one circulation, snapshots and ordinals stay). Owner confirms (Q1). |
| 2   | Label application consumes one `NEW_BOTTLE`; recipe puts the label in `LABEL_APPLICATION` | "Materiál se spotřebovává při plnění"                                 | Nothing already consumed is consumed again. Bottle body: at labelling (unchanged). Liquid + pump: at the finished-bottle scan. Label stock: **owner decision** (Q2) — not consumed today.                                                  |
| 3   | Two crate types (soap, gel)                                                               | One shared `CRATE-40` type for both categories                        | Already possible (doc 023). A cycle stays single-product by its snapshot.                                                                                                                                                                  |
| 4   | Doc 020 v0.1 excludes filling                                                             | Stage A must fill                                                     | This document is the extension. Nothing of filling exists yet.                                                                                                                                                                             |
| 5   | Doc 020 labelling only inside a production order with reservations                        | Production to stock, stations                                         | Stage A works **without** production orders and reservations (Q4): the product and the recipe version are chosen explicitly and snapshotted on the crate cycle. Availability is checked under the balance lock at every scan.              |

**Variant A vs. B (Q1).** A (ADR 0021): labelled empties are packed into the crate first, the
crate is filled as a whole; the crate then proves which bottles were _intended_, but not which
were actually filled, and every fill still needs a per-bottle confirmation. B (latest owner
text): the crate holds only finished bottles; nothing has to be "unpacked" when a bottle fails
filling. B is simpler and matches the newest description; it is the proposal.

## 3. States

### 3.1 Bottle (`bottles.status`, ADR 0011 unchanged)

```
CREATED ──Potvrdit nalepení (LABEL_APPLIED)──► LABELED_EMPTY ──Potvrdit naplnění (FILLED)──► FILLED
```

- New status `FILLED` (Czech "Naplněná – hotová") and event `FILLED`. Later stages continue from
  `FILLED` (dispatch, hotel, return, washing) — not in stage A.
- **First vs. refilled bottle:** stage A fills only bottles that were never filled (no `FILLED`
  event). A returned/washed bottle is refused (`REFILL_NOT_SUPPORTED`) until the return and
  washing flow is approved; refilling will never re-consume the body or re-bind the category.
- **Category binding** (doc 020 `bottle_category_bindings`): created once at labelling from the
  product of the applied label (Q3), never changed. Bottles labelled before this change have no
  binding and are refused at filling (`BOTTLE_WITHOUT_PRODUCT`) — no guessed binding (Q5).
- Holds (doc 020 `bottle_holds`) make a bottle ineligible; stage A only reads them (no hold UI).

### 3.2 Crate (`crates.status`) vs. crate cycle (`crate_cycles.status`)

The crate lives for years (`ACTIVE` → `RETIRED`, retirement not in stage A); each circulation is
one cycle (ADR 0021). Stage A cycle states (ADR 0021 names, assembly order of variant B):

```
(crate scanned at a filling station) ──► FILLING ──Hotovo: active assignments = capacity──► FILLED
FILLING ──abort while empty or by supervisor (reason, bottles released one by one)──► ABORTED
```

- `FILLED` = **ready finished stock** ("Připravená"). Later: `ALLOCATED → DISPATCHED → AT_HOTEL
→ RETURNING → RECEIVED → CLOSED` on the **same row** (ADR 0021).
- At most one open cycle per crate; only `ABORTED`/`CLOSED` free it. `OPEN_ASSEMBLY` and
  `READY_TO_FILL` are not used by variant B.
- Crate list state is derived: no open cycle = **Prázdná**, `FILLING` = **Rozpracovaná n/40**,
  `FILLED` = **Připravená**.

### 3.3 Workstation session

```
ACTIVE ──release / station change──► RELEASED      ACTIVE ──supervisor takeover (reason)──► TAKEN_OVER
```

Lease 15 min (configuration, doc 020 §6). Expiry releases only station ownership — never a crate
cycle, a lot or a bottle.

## 4. Step → scan → event → stock matrix

| Physical step                            | Scan / confirmation               | Records (one transaction, one operation id)                                                                                            | Stock movement                                                                            |
| ---------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Register crates                          | form                              | `crate_registrations`, `crates`, `qr_identities` (kind `CRATE`), crate event `REGISTERED`                                              | none                                                                                      |
| Print / reprint crate labels             | button                            | crate print job + items (same token, same URL), crate event `LABEL_PRINTED`                                                            | none                                                                                      |
| Print bottle labels                      | existing                          | existing print jobs                                                                                                                    | none (Q2)                                                                                 |
| Open labelling station                   | station QR, lot of new bottles    | session                                                                                                                                | none                                                                                      |
| Label applied to an empty body           | bottle QR = **Potvrdit nalepení** | `LABELED_EMPTY`, `LABEL_APPLIED`, LABEL attachment, category binding                                                                   | −1 `NEW_BOTTLE` from the selected lot (existing); label stock only if Q2 says so          |
| Open filling station                     | station QR, product, liquid lot   | session with product + recipe-version snapshot + liquid lot                                                                            | none                                                                                      |
| Start a crate                            | crate QR                          | new cycle `FILLING` with snapshot (crate type, capacity, product, category, recipe version) + `CYCLE_OPENED`, or continue the open one | none                                                                                      |
| Bottle checked before filling (optional) | bottle QR in "Ověřit" mode        | nothing (read-only answer: product, liquid, compatible yes/no)                                                                         | none                                                                                      |
| Bottle filled and completed              | bottle QR = **Potvrdit naplnění** | `FILLED` status + event, PUMP attachment, assignment (lowest free ordinal), `ASSIGNED_TO_CRATE`                                        | −FILL liquid (recipe quantity, e.g. 330 ml) from the session's lot, −1 pump; nothing else |
| Crate complete                           | **Hotovo**                        | cycle `FILLED`, crate event `CRATE_FILLED`                                                                                             | none                                                                                      |

The finished-goods stock is **the crate cycles in `FILLED`** and their assignments — no second
piece-stock of filled bottles in the inventory ledger.

The optional check scan (the owner asked to verify suitability before filling) never writes. The
confirming scan is a separate, explicit mode so that one accidental read cannot both check and
confirm. Exact gesture for review (Q6): the station screen has a large mode switch **Ověřit /
Potvrdit hotové**, default **Potvrdit hotové** (the required step); a check scan never consumes.

## 5. Proposed models (new — approval required except A1)

| Table                               | Purpose and key rules                                                                                                                                                         | Basis              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `qr_identities`                     | token PK, kind `BOTTLE`/`CRATE`/`WORKSTATION`; tokens unique across all kinds; bottle tokens copied in, bottle rows unchanged                                                 | doc 020 (+ kind)   |
| `crate_registrations`, `crates`     | `CR-000001`; `AYV-C-000001`, qr_token, crate type, **site_id** (doc 022), status `ACTIVE`/`RETIRED`                                                                           | doc 020 (A1)       |
| `crate_label_print_jobs` (+items)   | fixed items, snapshot of base URL, environment, error correction, **label width/height (mm)**                                                                                 | doc 020 (A1)       |
| `crate_events`                      | append-only, site_id, location_id (NULL = not recorded), actor, operation id                                                                                                  | doc 020 (A1)       |
| `workstations`                      | code, name, site, warehouse, **mode** `LABELING`/`FILLING`, category (FILLING), status `ACTIVE`/`INACTIVE`, qr_token; created and deactivated by ADMIN/supervisor with reason | **new**            |
| `workstation_sessions` (+events)    | user, workstation, lease, liquid lot / bottle lot, product, recipe version, current crate cycle; partial unique: one active session per crate and per user                    | doc 020 §6 adapted |
| `crate_cycles`, `crate_assignments` | as doc 020 §3.4 with stage A states (§3.2); assignment source `FILL`                                                                                                          | doc 020            |
| `bottle_category_bindings`          | as doc 020 §3.5; bound with the **product** of the labelling (Q3)                                                                                                             | doc 020 (+product) |
| `product_label_approvals`           | label template version ↔ product (doc 020 §3.3) — how labelling knows the product                                                                                             | doc 020            |
| enums                               | bottle status `FILLED`; bottle events `FILLED`, `ASSIGNED_TO_CRATE`; movement type `FILL`; operation kinds                                                                    | new values         |

Workstations are **work modes at a site**, never sites or warehouses. A station QR only names the
station: it is not a login, not a permission and not a secret. The public QR page of a station
token shows nothing but "Interní označení AYVO"; of a crate token only "Vratná bedna AYVO" and a
safe contact (doc 020 §3.4). Hotel, order, content, location and workflow are never public.

## 6. Server rules at every scan

The request carries only `{requestId, sessionId, scannedValue}`; station, mode, category,
product, recipe snapshot, lot, crate and site come from the session. Lock order (doc 020 §8):
operation request → session → crate → cycle → bottle → balances.

Refusals (Czech text + sound + visible state, scanner keeps focus), without any write:
`STATION_INACTIVE`, `STATION_OF_ANOTHER_SITE`, `SESSION_NOT_OWNED`, `WRONG_STATION_MODE`,
`WRONG_CATEGORY` (soap bottle at the gel station and vice versa), `PRODUCT_MISMATCH`,
`LABEL_VERSION_MISMATCH`, `BOTTLE_NOT_LABELED`, `ALREADY_FILLED`, `REFILL_NOT_SUPPORTED`,
`BOTTLE_ON_HOLD`, `BOTTLE_OF_ANOTHER_SITE`, `IN_ANOTHER_CRATE`, `CRATE_FULL`, `CRATE_IN_USE`,
`CRATE_NOT_FILLING`, `LOT_EXHAUSTED`, `INSUFFICIENT_STOCK` (pump), `CRATE_INCOMPLETE` (Hotovo
below capacity). A recipe change never switches silently: the cycle keeps its snapshot when a
newer recipe version is activated; only a new cycle takes the then active version.

Idempotency and concurrency: same request id → stored result; a new request id for an already
filled bottle → `ALREADY_FILLED` decided under the bottle lock; two stations → the crate's
partial unique session; 41st bottle → ordinal CHECK; two operators pressing Hotovo → the cycle
lock, the second gets the stored state. Database invariants as doc 020 §9 plus: `FILLED` cycle ⇔
active assignments = capacity (commit-time); a `FILL` movement belongs to a `FILLED` event of a
bottle assigned to a cycle of the same recipe snapshot; one `FILLED` event per bottle in stage A.

## 7. Permissions (proposal; ADMIN granted by migration, doc 021)

| Permission                                                 | PROD. OPERATOR | PROD. SUPERVISOR | WH. OPERATOR | WH. SUPERVISOR | ADMIN |
| ---------------------------------------------------------- | :------------: | :--------------: | :----------: | :------------: | :---: |
| `crates:read` (doc 020)                                    |       ✓        |        ✓         |      ✓       |       ✓        |   ✓   |
| `crates:register` + crate labels (doc 020)                 |                |        ✓         |              |       ✓        |   ✓   |
| `production:workstations_manage` (new)                     |                |        ✓         |              |                |   ✓   |
| `production:label_apply` (exists, at a station)            |       ✓        |        ✓         |              |                |   ✓   |
| `production:fill` (new: open crate, finished scan, Hotovo) |       ✓        |        ✓         |              |                |   ✓   |
| `production:cycle_abort` (doc 020)                         |                |        ✓         |              |                |   ✓   |
| `production:session_takeover` (doc 020)                    |                |        ✓         |              |                |   ✓   |

Warehouse operators currently do **not** hold `production:read`; whether they get the role
`PRODUCTION_OPERATOR` or a station permission is a role assignment, not a code change.

## 8. Later stages this design must not block

- **Dispatch (C):** one scan of a `FILLED` crate allocates its exact assignments to an order line
  (`ALLOCATED`), stored as historical links (not the dynamic crate content); allocation ≠
  dispatch; a retry never doubles content or consumption.
- **Returns:** a returned crate scan records only the crate (`RECEIVED`); bottles are identified
  one by one, their assignments released individually; missing bottles stay "not returned",
  never auto-written-off; a bottle returned in another crate never rewrites its dispatch
  history. Return, assignment release, crate-cycle close and bottle reuse cycle are separate
  facts. Washing and refill eligibility are real operations, never implied by a scan. Criteria
  are owner decisions (doc 009, open).
- **Component removal and scrapping:** removing an installed pump is an attachment end, never a
  second stock consumption; a replacement pump is consumed once at installation; RETIRED vs.
  DISPOSED/DESTROYED as ADR 0011; a relabel keeps the QR identity. Not in stage A.

## 9. PR split

| PR     | Content                                                                                                                                                                                               | Gate                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A0     | this document + ADR 0025 (variant B) after the answers                                                                                                                                                | owner review                   |
| **A1** | physical crates: registry, bulk registration, QR identities (`qr_identities`), crate label PDF with configurable size + preview, reprint with the same token, list/detail per site, public crate page | doc 020 approved — **started** |
| A2     | workstations + station QR + server-side sessions (lease, resume, release, takeover)                                                                                                                   | after approval                 |
| A3     | labelling at a station: product via `product_label_approvals`, category binding (+ label consumption if Q2)                                                                                           | after approval + Q2/Q3/Q5      |
| A4     | filling: crate cycles `FILLING`/`FILLED`, check scan, finished-bottle scan with FILL consumption, Hotovo, abort                                                                                       | after approval + Q1/Q4         |
| A5     | Bedny overview of ready crates per site, full Playwright flow labelling → filling → ready list, mobile                                                                                                | after A4                       |

## 10. Honest limits

- The station scan does not prove which liquid a person poured or where the station physically
  stands; a wrong liquid is detected only if the bottle or lot does not match, not by software
  before pouring. Mitigation: visible station signage, liquid lot chosen explicitly at session
  start and shown permanently, physically separate liquid stocks. No sensor or hardware lock
  exists.
- With variant B a wrongly labelled bottle is detected at its finished scan, i.e. after it was
  filled (owner accepted). The optional check scan reduces this.
- Crate location is the **last recorded location only**. Registration records the site, not a
  warehouse; until a crate is used at a station its location is shown as "Neevidováno".

## 11. Owner questions (one list)

1. **Q1 — crate order:** confirm variant B (crate opened first, only finished bottles scanned
   in; ADR 0021 pre-fill assembly superseded).
2. **Q2 — label stock:** is the product label item (`LABEL-…`, ks) consumed at **application**
   (one per bottle at "Potvrdit nalepení"), at printing, or not tracked as stock? What is printed
   on it — the product artwork and the bottle QR on one label?
3. **Q3 — product at labelling:** may labelling bind the bottle to the **product** of the label
   design (each label template version approved for exactly one product), so filling can refuse
   a wrong bottle before pouring?
4. **Q4 — no production orders in stage A:** production to stock without orders and
   reservations; product + recipe chosen at the filling session. Doc 020 orders/reservations
   later or never?
5. **Q5 — existing labelled empty bottles** (labelled before this change, no product binding):
   refuse at filling (proposal) or allow a supervised one-time binding?
6. **Q6 — gesture:** two-mode station screen (Ověřit / Potvrdit hotové, default Potvrdit) — OK?
7. **Q7 — crate label size:** the physical size and printer are not approved; A1 lets the user
   choose width/height per print job (bounded) with a preview. Any target size to pre-select?
8. **Q8 — permissions:** matrix §7 OK (new `production:fill`, `production:workstations_manage`)?
