# 020 — Production Core v0.1 (design)

Status: **Approved design — not implemented** (owner decisions 2026-10-11). Implementation starts
only PR by PR as authorized (section 14). Architecture decisions: [ADR 0021](adr/0021-crate-capacity-and-circulation-cycle.md)
(crate capacity 40 and the full-circulation crate cycle, superseding ADR 0004) and
[ADR 0022](adr/0022-external-oidc-authentication.md) (external OIDC authentication, superseding the
provider question of ADR 0017).

Production Core builds on Milestones 1, 2A and 2A.1 (docs [016](016-bottles-and-labels.md),
[018](018-inbound-stock-and-label-activation.md), [019](019-app-shell-and-information-architecture.md));
it reuses their tables and services and does not rewrite them (section 11).

## 1. Confirmed operating model (owner, 2026-10-11)

- **Product ≠ label template.** A product is a concrete operational variant such as
  "Tekuté mýdlo 330 ml" with its nominal quantity. `NEW_BOTTLE` stays the anonymous bottle-body
  inventory item.
- A **production order** defines product, approved recipe version, approved label-template
  version and planned quantity. Labels are printed in bulk for the order.
- "Label application" is **not** a standalone business function: the operator opens a production
  order, claims a reusable crate, selects a source lot of anonymous bottles and scans bottles
  continuously.
- One successful bottle scan atomically validates order, identity, label and product; consumes
  exactly one anonymous bottle from the selected lot; physically activates the bottle; validates
  crate compatibility; assigns the bottle to the crate's open cycle; and records which production
  order did it.
- **Crates:** two crate types now (hand soap, shower gel); every physical crate has a permanent QR
  identity; **capacity 40** — the same crate is used for assembly, filling, shipment to the hotel
  and the return to AYVO; there is no separate 20-bottle outbound crate (ADR 0021).
- One **crate cycle** is one complete circulation. The 40th eligible bottle moves it to
  `READY_TO_FILL`; a 41st is impossible. A partial crate never becomes ready manually; a smaller
  order may complete while its crate stays partially filled, and a later order continues it only
  when **all** snapshots match (product, product category, recipe version, label-template
  version, crate type).
- The first physically confirmed label **permanently binds the bottle's product category**
  (`HAND_SOAP` or `SHOWER_GEL`); a hand-soap bottle can never become a shower-gel bottle.
- The UI shows production-order progress and crate progress separately.
- **Out of scope** (section 15): filling, liquid consumption, returns, hotels, PPL, billing,
  commissions.

## 2. Modules

| Module (Nest)      | Owns                                                                                               | Status    |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------- |
| `identity`         | AYVO users, external identities, roles, permissions, scopes, the auth-provider boundary (ADR 0022) | new       |
| `catalog`          | product categories, products, product-label approvals, recipe versions                             | new       |
| `crates`           | crate types, crates, crate labels, crate cycles, assignments, crate events                         | new       |
| `production`       | production orders, order series, work sessions, the production scan                                | new       |
| `inventory`        | ledger, balances, lots, BOM (= recipe components), **reservations**                                | extended  |
| `assets`           | bottles, bottle events, component attachments, **category bindings, holds, identity voids**        | extended  |
| `label-production` | creation series, print jobs, **print-item voids, reprint jobs**                                    | extended  |
| `labels`           | templates, versions, renderer — unchanged (still imports no bottle or crate code)                  | unchanged |

Modules talk through exported services; cross-module foreign keys exist for integrity only (as
today, e.g. creation batch → label template version).

## 3. Entities and relationships

All new tables are insert-only except explicitly guarded current-state columns (status,
counters, lease, close fields), which change only in the same transaction as the event that
justifies them (ADR 0006). Identity columns are immutable (triggers). Nothing is ever deleted.

### 3.1 Correlation

Every state-changing operation runs through `OperationRequestsService`; its `request_id` is the
**operation id**. New tables carry `operation_request_id` (FK `operation_requests`), and the new
nullable column is added to `bottle_events`; `inventory_movements.request_id` already exists. One
production scan therefore links its bottle event(s), stock movement(s), reservation movement,
crate assignment, crate event(s) and session event through one id.

### 3.2 Identity (`identity`, ADR 0022)

| Table              | Key columns                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`            | id, email, display_name, status `ACTIVE`/`DEACTIVATED`, created_at/by, deactivated_at/by/reason                                                 |
| `user_identities`  | id, user_id, provider (`WORKOS`), subject, linked_at/by, unlinked_at — unique (provider, subject) while linked                                  |
| `roles`            | code PK: `PRODUCTION_OPERATOR`, `PRODUCTION_SUPERVISOR`, `WAREHOUSE_OPERATOR`, `WAREHOUSE_SUPERVISOR`, `ADMIN` (later: hotel and finance roles) |
| `role_permissions` | role_code, permission — seeded by migration (section 12)                                                                                        |
| `user_roles`       | id, user_id, role_code, granted_at/by, revoked_at/by/reason — at most one open grant per (user, role)                                           |
| `user_scopes`      | id, user_id, scope_type `WAREHOUSE`/`HOTEL_ORGANIZATION`/`HOTEL_SITE`, scope_id, granted/revoked — warehouse scope = inventory location now     |
| `audit_events`     | id, actor_id, type (login, role change, takeover, emergency override, …), reason, operation_request_id, payload, occurred_at                    |

Every new production/crate/catalog table has `NOT NULL` actor columns referencing `users`
(authentication lands before them, section 14). Existing tables keep their nullable actor columns;
their historical rows stay `NULL`.

### 3.3 Catalog (`catalog`)

| Table                     | Key columns and rules                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_categories`      | code PK, name — seeded `HAND_SOAP`, `SHOWER_GEL` (confirmed). A table, not an enum, so a third category needs no enum migration.                                                                  |
| `products`                | id, code (unique), name ("Tekuté mýdlo 330 ml"), category_code (FK, immutable), nominal_quantity `NUMERIC(19,3)`, nominal_unit_id, status `ACTIVE`/`ARCHIVED`, created_at/by                      |
| `product_label_approvals` | id, product_id, **label_template_version_id** (exact immutable version), approved_at/by, revoked_at/by/reason — at most one open approval per (product, version); revoking blocks new orders only |
| `recipe_versions`         | id, product_id, version (unique per product), status `DRAFT`/`APPROVED`/`RETIRED` (forward only), created_at/by, approved_at/by                                                                   |
| `recipe_version_stages`   | recipe_version_id, stage, bom_version_id — PK (recipe_version_id, stage); immutable once the recipe is approved                                                                                   |

**RecipeComponent = `bom_lines`** of the linked BOM versions (no second component table). The
existing BOM tables fully support recipes (verified against migration
`20261011150100`): lines are exact `NUMERIC(19,3)` in the item's base unit with a scale check
(pieces whole), versions and lines reject UPDATE/DELETE, and the commit-time label-application
checks accept any single complete BOM of stage `LABEL_APPLICATION`. Conditions:

1. Each recipe owns its own BOM versions (code e.g. `R-<PRODUCT>-v<n>-<STAGE>`); its activation
   stage uses stage `LABEL_APPLICATION` (e.g. 1 pcs `NEW_BOTTLE`); stage `FILL` is added for
   2B — its lines (liquid in ml, pump) may be stored now but are never consumed in v0.1.
2. Recipe BOMs are found **by id through the recipe**, never through `InventoryService.activeBom(stage)`
   (which picks the globally active rule); the legacy global rule `LABEL_APPLICATION` v1 stays only
   for history.
3. One BOM per stage per recipe (PK); every activation line names a lot-tracked item.
4. New commit-time check: a `LABEL_APPLIED` event of a production order consumed exactly the
   activation BOM recorded on that order.
5. `valid_from`/`valid_to` have no meaning for recipe BOMs (set at creation, ignored).

The product's nominal quantity and a recipe's `FILL` liquid quantity are separate data (overfill
policy is a 2B question, not modelled now).

### 3.4 Crates (`crates`)

| Table                             | Key columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crate_types`                     | id, code, name, **capacity** (data; 40 for both seeded types), status                                                                                                                                                                                                                                                                                                                                                                           |
| `crate_type_categories`           | crate_type_id, category_code — PK both (one-to-one today, a table so a multi-category type needs no rewrite)                                                                                                                                                                                                                                                                                                                                    |
| `qr_identities`                   | token PK (22 base64url chars), kind `BOTTLE`/`CRATE` — one global registry so tokens are unique across bottles and crates in the database; existing bottle tokens are copied in (bottles unchanged)                                                                                                                                                                                                                                             |
| `crate_registrations`             | id, serial, code `CR-000001`, client_request_id (unique), crate_type_id, quantity, created_at/by                                                                                                                                                                                                                                                                                                                                                |
| `crates`                          | id, serial, **code** `AYV-C-000001` (human-readable), **qr_token** (opaque, FK registry), crate_type_id, registration_id, status `ACTIVE`/`RETIRED`, created_at — the scan identity is the token, never the code or the database id                                                                                                                                                                                                             |
| `crate_label_print_jobs` (+items) | AYVO-generated controlled crate labels rendered by the `labels` renderer from a label template version; same PDF rules and DEV marking as bottle labels                                                                                                                                                                                                                                                                                         |
| `crate_cycles`                    | id, crate_id, status, opened_at, ready_to_fill_at, aborted_at, closed_at, opened_by, opening_order_id (display); **immutable snapshot**: crate_type_id, capacity, product_id, category_code, recipe_version_id, label_template_version_id                                                                                                                                                                                                       |
| `crate_assignments`               | id, cycle_id, bottle_id, **ordinal** (1…capacity), cycle_capacity, **slot_code** (NULL; reserved for a future physical grid), snapshot copies (product_id, recipe_version_id, label_template_version_id), source `ACTIVATION`/`REASSIGNMENT`, production_order_id, session_id, assigned_event_id (unique), operation_request_id, assigned_at/by; release (closed once): released_at/by, release_reason, released_event_id, release_operation_id |
| `crate_events`                    | append-only: id, crate_id, cycle_id, type, occurred_at/recorded_at, actor_id, operation_request_id, production_order_id, session_id, reason, payload                                                                                                                                                                                                                                                                                            |

Crate event types in v0.1: `REGISTERED`, `LABEL_PRINTED`, `CYCLE_OPENED`, `CLAIMED`,
`CLAIM_RELEASED`, `CLAIM_TAKEN_OVER`, `BOTTLE_REMOVED`, `READY_TO_FILL`, `RETURNED_TO_ASSEMBLY`,
`CYCLE_ABORTED`. Individual assignments are history rows themselves (no crate event per bottle).

**Crate QR:** URL = existing QR base URL + `/` + token (ADR 0014 policy; DEV
`https://dev.ayvo.co/q/<token>`, production `https://qr.ayvo.co/<token>` only in production). The
public page of a crate token shows only that this is a reusable AYVO crate, a safe AYVO contact or
return instruction and optionally a generic non-sensitive state — never hotel/customer, order,
contents or count, tracking, internal location or history. Internal crate detail requires
authentication and permission.

### 3.5 Bottles (`assets`)

| Table / change                | Key columns and rules                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bottle_category_bindings`    | **bottle_id PK** (bound once, forever), category_code, bound_event_id (the `LABEL_APPLIED`, unique), production_order_id, bound_at, operation_request_id — insert-only                                              |
| `bottle_holds`                | id, bottle_id, type `QUARANTINE`, reason, defect_kind (e.g. `BODY_DAMAGED`), opened_at/by/event_id, operation_request_id; closing fields for the future Quality workflow — at most one open hold per (bottle, type) |
| `bottle_identity_voids`       | bottle_id PK, reason, production_order_id, voided_at/by, operation_request_id — only for identities that were never activated                                                                                       |
| `bottle_events` (new columns) | nullable production_order_id, crate_cycle_id, session_id, operation_request_id — existing rows stay `NULL`, no backfill                                                                                             |
| new event types               | `ASSIGNED_TO_CRATE`, `REMOVED_FROM_CRATE`, `QUARANTINED`, `IDENTITY_VOIDED`, `REPLACEMENT_REQUESTED` (on the defective bottle, referencing the replacement identity)                                                |

`bottle_holds` is an **eligibility overlay**, not a lifecycle status: every operational guard
(production scan, reassignment, future filling, picking, delivery) refuses a bottle with an open
hold. After activation a bottle stays `LABELED_EMPTY` while on hold; it never reverts to
`CREATED`.

### 3.6 Labels (`label-production`)

| Table / change           | Key columns and rules                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label_print_item_voids` | print_job_id + position (unique), reason, voided_at/by, approved_by (bulk/exceptional), operation_request_id                                                                               |
| `label_print_jobs.kind`  | `SERIES` (existing full-series jobs) or `REPRINT` (items of one series only, each with a void, reason required). The rule "a print job renders the whole series" applies to `SERIES` only. |

A reprinted label carries the **same** QR token (identity and URL are permanent): a scan cannot
tell original from reprint. The void is label-media accounting; the existing "most recent
completed print" logic attaches the reprint item at activation. A damaged label never creates a
new bottle identity.

### 3.7 Production (`production`)

| Table                       | Key columns and rules                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production_orders`         | id, serial, code `PO-000001`, client_request_id (unique), status, planned_quantity (1–1000 in v0.1), **immutable snapshot**: product_id, category_code, recipe_version_id, label_template_version_id, activation_bom_version_id; progress counters (section 7); material_blocked (overlay, section 5); timestamps; created_by, released_by, cancelled_by, cancel_reason |
| `production_order_series`   | production_order_id, creation_batch_id (unique), purpose `PLANNED`/`REPLACEMENT`, defect_hold_id (required for `REPLACEMENT`) — v0.1: exactly one `PLANNED` series per order (partial unique, droppable later); `REPLACEMENT` series hold replacement identities                                                                                                        |
| `production_work_sessions`  | section 6                                                                                                                                                                                                                                                                                                                                                               |
| `production_session_events` | append-only session history: opened, crate claimed/released, lot selected, heartbeat gap, expired-observed, resumed, released, taken over (reason), closed                                                                                                                                                                                                              |

Database links: composite FK (product_id, label_template_version_id) → open product-label approval;
(recipe_version_id, product_id) → approved recipe of that product; unique (id, product_id,
recipe_version_id, label_template_version_id) so assignments can reference the full snapshot.

### 3.8 Inventory reservations (`inventory`)

| Table                             | Key columns and rules                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inventory_reservations`          | id, item_id, unit_id, location_id, lot_id (NULL = item/location level), demand_type `PRODUCTION_ORDER`, production_order_id, bom_line_id, quantity_reserved, **open_quantity**, **uncovered_quantity** (trigger-maintained), created_at/by, operation_request_id               |
| `inventory_reservation_movements` | append-only: reservation_id, type `RESERVE`/`CONSUME`/`RELEASE`/`MARK_UNCOVERED`/`RESTORE_COVERAGE`, quantity_delta, inventory_movement_id (unique; required for `CONSUME`), receipt_correction_id (for `MARK_UNCOVERED`), operation_request_id, occurred_at, actor_id, reason |
| `inventory_reservation_totals`    | per (item, location): open and uncovered totals — written only by trigger                                                                                                                                                                                                      |

## 4. State machines

### 4.1 ProductionOrder

```
DRAFT ──release (PRODUCTION_SUPERVISOR)──► READY ──first activation──► IN_PROGRESS ──eligible output = planned──► COMPLETED
DRAFT ──cancel (reason)──► CANCELLED
READY ──cancel (reason; only with zero activations)──► CANCELLED
```

- `DRAFT` is immutable (no generic edit; a wrong draft is cancelled and recreated — nothing has been
  reserved or created yet).
- **Release** (one transaction): reserve activation material (section 5), create the `PLANNED`
  series of exactly `planned_quantity` identities via the extracted registration step, link it,
  create its `SERIES` print job (PENDING). PDF generation stays outside the transaction (existing).
- Scanning requires `READY`/`IN_PROGRESS`, no material block, and a completed print of the scanned
  identity (existing `LABEL_NOT_PRINTED`).
- **Cancel from `READY`** releases the whole reservation, voids every identity of the order
  (`IDENTITY_VOIDED` + `bottle_identity_voids`) and every printed item (`label_print_item_voids`),
  in one transaction. Cancelling `IN_PROGRESS` and **short close are not in v0.1**; their future
  design must reconcile every unused identity, print and reservation the same way.
- No status is ever set manually; every transition is a named, permission-guarded operation.

### 4.2 CrateCycle — one full circulation (ADR 0021)

Implemented in v0.1:

```
(first eligible bottle of a session) ──► OPEN_ASSEMBLY ──active assignments = capacity──► READY_TO_FILL
READY_TO_FILL ──remove damaged bottle (PRODUCTION_SUPERVISOR, reason; before filling)──► OPEN_ASSEMBLY
OPEN_ASSEMBLY ──abort (PRODUCTION_SUPERVISOR, reason; assignments released one by one)──► ABORTED
```

Future continuation of the **same row** (design note, not built):

```
READY_TO_FILL → FILLING → FILLED (finished stock) → ALLOCATED → DISPATCHED → AT_HOTEL
→ RETURNING → RECEIVED → CLOSED
```

- A partial cycle never becomes `READY_TO_FILL` manually; only the 40th eligible assignment does.
- After filling has started, the `READY_TO_FILL → OPEN_ASSEMBLY` shortcut is no longer allowed; a
  later filling/quality exception workflow handles defects.
- Only `ABORTED` and `CLOSED` free the crate for a new cycle.
- A future return receipt links to this cycle (no separate return cycle). Return contents may be
  partial, mixed or unknown (confirmed); bottle assignments are released individually at
  identification/sorting, and `CLOSED` will require no active assignment.

### 4.3 Bottle (this milestone)

```
CREATED ──LABEL_APPLIED (production scan)──► LABELED_EMPTY
```

The same transaction creates the immutable category binding, `ASSIGNED_TO_CRATE` and the crate
assignment. Crate membership, holds and identity voids are separate records — never the bottle
status. A voided identity stays `CREATED`, permanently marked by its void and refused at scan
(`IDENTITY_VOIDED`).

### 4.4 ProductionWorkSession

```
ACTIVE ──release by owner──► RELEASED
ACTIVE ──takeover (PRODUCTION_SUPERVISOR/ADMIN, reason)──► TAKEN_OVER
ACTIVE ──order completed / crate ready and no further work──► CLOSED
```

Lease expiry is **not** a status change (section 6).

## 5. Material reservations

- **Level:** item + location (e.g. `NEW_BOTTLE` at `MAIN`), `lot_id` NULL. Any lot of that item at
  that location satisfies it; the stock movement still records the exact lot the operator selected
  for the session, so lot traceability is unchanged. `lot_id` exists for later lot-level
  allocation (liquids with expiry); filling-stage pump and liquid reservations will use the same
  tables with the recipe's `FILL` lines (2B).
- **Available** = on hand (all lots of item/location) − open reservations. The stock screen shows
  real reserved and available figures.
- **Release to READY** reserves `planned_quantity × activation line quantity` per activation line,
  under a lock of the reservation-total row and then the balance rows of that item/location
  (ascending). Refused with `INSUFFICIENT_AVAILABLE_STOCK` if available would go negative. No
  physical balance changes.
- **Each activation**: −1 stock movement on the session lot (existing type `LABEL_APPLICATION`)
  and a `CONSUME` reservation movement referencing exactly that stock movement — available stays
  unchanged (on hand and reserved both drop by one).
- **Replacement identity** (section 7): `RESERVE` of one more activation unit in the same
  transaction; if not available, the order becomes material-blocked.
- **Cancellation**: `RELEASE` of the open quantity.
- **Receipt correction below reserved** (owner decision): allowed — physical truth wins — but only
  for `WAREHOUSE_SUPERVISOR`, after an impact preview listing affected reservations and production
  orders, with a mandatory reason, in **one transaction** that records the correction, writes
  `MARK_UNCOVERED` on **every** open reservation of that item/location (no invented priority
  between orders) and sets the affected orders `material_blocked`. Availability is shown as a
  shortage, never as a silent negative number, and blocked orders refuse scans
  (`ORDER_MATERIAL_BLOCKED`). A `WAREHOUSE_SUPERVISOR` resolves coverage (`RESTORE_COVERAGE`) once
  available stock covers the reservation again (e.g. after a receipt); the order unblocks in the
  same transaction.
- **Database checks:** open ≥ 0, uncovered between 0 and open; `CONSUME` matches its stock movement
  (item, location, quantity) and belongs to a `LABEL_APPLIED` of the same order; at commit,
  `COMPLETED`/`CANCELLED` ⇒ open = 0; an order with uncovered > 0 is material-blocked.

## 6. ProductionWorkSession — lease and takeover

Columns: id (UUID, the safe resume identity, usable only by its owner), production_order_id,
operator_id, workstation_label, crate_id, crate_cycle_id (NULL until a cycle is open), lot_id,
location_id, status, **lease_expires_at**, last_heartbeat_at, last_scan_at, opened_at, closed_at,
close_reason. Choices change only through operations that also write `production_session_events`.

- **Lease:** 15 minutes of inactivity (system configuration, not a code constant). The open station
  page sends a heartbeat; every scan also refreshes the lease. Lease expiry releases only
  **workstation ownership**: it never closes or modifies the crate cycle.
- **Database:** at most one `ACTIVE` session per crate (partial unique) — two stations can never
  assemble the same crate unknowingly; the second station gets `CRATE_IN_USE` with order, operator
  and last activity of the holder. At most one `ACTIVE` session per (operator, order).
- **Resume:** the same operator resumes their own session (expired or not) after reload or
  re-login; the station page asks the server for the operator's session of that order — no browser
  storage is involved.
- **No silent takeover:** another operator cannot claim a crate held by a foreign session, expired
  or not. Only `PRODUCTION_SUPERVISOR` or `ADMIN` with `production:session_takeover` may take over
  an expired or active foreign session, with a reason; this closes it as `TAKEN_OVER`, releases the
  crate claim and writes a session event, a crate event and an audit event under one operation id.
- **Release:** an operator may explicitly release their own session (`RELEASED`, crate claim
  released).
- **Scans trust only the server:** a scan request carries `{requestId, sessionId, scannedValue}`;
  order, crate, cycle, lot and location come from the session. A scan on an expired lease by its
  owner first renews the lease (same operator), otherwise it is refused (`SESSION_NOT_OWNED`).
- When the crate reaches `READY_TO_FILL` the session releases the crate (the operator claims the
  next crate); when the order completes the session closes.

## 7. Progress, defects and replacements

`planned_quantity` = the required number of **currently eligible physical bottles** produced by
the order. Counters on the order (current state, changed only with their events):

| Counter             | Meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `activated_count`   | identities of this order activated (`LABEL_APPLIED`) — history, never decreases |
| `eligible_count`    | activated by this order, no open hold, not scrapped — the completion measure    |
| `on_hold_count`     | activated by this order with an open hold (rework/quarantine)                   |
| `scrapped_count`    | bodies scrapped (future Quality workflow; 0 in v0.1)                            |
| `replacement_count` | replacement identities created for defects                                      |

- The order becomes `COMPLETED` only when `eligible_count = planned_quantity` (commit-time check
  against events and holds).
- **Damaged body after assignment** (removal, section 9): the activation and its stock consumption
  remain history; the bottle gets a hold and leaves eligible output; the order may create an
  explicit **replacement identity** tied to the defect (`REPLACEMENT` series of one identity
  referencing the hold, `REPLACEMENT_REQUESTED` event on the defective bottle, one more unit
  reserved, a `REPRINT`-style single-label print job). The replacement is activated by a normal
  scan.
- **Damaged label only:** the same identity is kept; the label item is voided and reprinted for
  that identity (`REPRINT` job). No replacement bottle, no new identity.
- **Defect found after the order is `COMPLETED`** (e.g. removal from a `READY_TO_FILL` crate): the
  order is not reopened (statuses only move forward); its counters record the loss, and the crate's
  freed ordinal is filled by a later compatible order. Replacing the lost output is planned as a
  new order.

## 8. The production scan — transaction and exact lock order

Canonical lock order for every operation (subsets allowed, never reversed): operation request →
work sessions → production orders → crate → crate cycle → bottles → reservations →
reservation totals → stock balances. Where several rows of one kind are locked, they are locked in
id order. When an operation must first find which rows it needs (e.g. the order that activated a
bottle), it reads them without lock, then locks in canonical order and re-verifies.

The production scan:

1. **operation request** (insert, or replay the stored result);
2. **work session** `FOR UPDATE` — `ACTIVE`, owned by the authenticated user (lease renewed), has
   crate and lot;
3. **production order** `FOR UPDATE` — `READY`/`IN_PROGRESS`, not material-blocked, eligible <
   planned;
4. **crate** `FOR UPDATE` — `ACTIVE`, claimed by this session, type compatible with the order's
   category; then its open cycle: none → insert `OPEN_ASSEMBLY` with the order's snapshot and
   `CYCLE_OPENED` (a second open cycle is impossible: partial unique); existing → must be
   `OPEN_ASSEMBLY` with **all five snapshots equal** (`CRATE_INCOMPATIBLE`; `CRATE_FULL` for
   `READY_TO_FILL`);
5. **crate cycle** `FOR UPDATE`;
6. **bottle** `FOR UPDATE` — QR classification (existing); identity in one of the order's series
   (`NOT_IN_ORDER`), not voided (`IDENTITY_VOIDED`), label printed (existing); no open hold
   (`BOTTLE_ON_HOLD`); then:
   - `CREATED` → **activation**;
   - `LABELED_EMPTY` with an active assignment → `ALREADY_ASSIGNED` (informative, no write);
   - `LABELED_EMPTY` without active assignment, category binding and its activation order's
     snapshot equal to the cycle → **reassignment** (no stock consumption);
   - otherwise `NOT_APPLICABLE`;
7. **reservation** of the order `FOR UPDATE` (activation only), then the **reservation-total** row
   (taken by the `CONSUME` trigger), then **stock balances** (existing ascending item → location →
   lot) → `LOT_EXHAUSTED` / `RESERVATION_EXHAUSTED`;
8. **writes** — activation: bottle status, `LABEL_APPLIED` (order, cycle, session, operation id),
   LABEL attachment (existing composed step), **category binding**, stock movement per activation
   BOM line on the session lot, `CONSUME`; both paths: `ASSIGNED_TO_CRATE`, assignment with
   ordinal = lowest free ordinal; if active assignments = capacity → cycle `READY_TO_FILL` + crate
   event, session releases the crate; order counters, first activation → `IN_PROGRESS`, eligible =
   planned → `COMPLETED` (session closes); session `last_scan_at`, lease;
9. **commit-time checks** — existing (complete BOM, attachment, ledger) and new (binding present
   and category = order category; reservation consumption matches; cycle status ⇔ active count;
   counters ⇔ events and holds; order's activation BOM).

Any failure — including a commit-time check — rolls back everything. Rejections are never stored
(a retry with the same request id is evaluated again).

**Other operations** (same order, subsets):

- **Remove bottle** (`PRODUCTION_SUPERVISOR`, reason; cycle `OPEN_ASSEMBLY` or `READY_TO_FILL`
  before filling): request → sessions of the crate → the bottle's activating order → crate →
  cycle → bottle (re-verified after locking); close the assignment (retained),
  `REMOVED_FROM_CRATE`, open hold + `QUARANTINED`, crate event `BOTTLE_REMOVED` (and
  `RETURNED_TO_ASSEMBLY` with the cycle back to `OPEN_ASSEMBLY` when it was ready), order counters
  of the bottle's activating order; the ordinal is free for a replacement — all under one
  operation id.
- **Abort cycle** (`PRODUCTION_SUPERVISOR`, reason; `OPEN_ASSEMBLY` only): request → sessions of
  the crate → crate → cycle → bottles in id order (no order lock: released good bottles stay
  eligible, so no order counter changes); release every active assignment individually
  with its own `REMOVED_FROM_CRATE` event (good bottles stay eligible and can be reassigned with
  matching snapshots), cycle `ABORTED`, crate event, sessions holding the crate closed.
- **Release / cancel order:** request → sessions of the order → order → reservation (new or
  existing) → reservation totals → balances.
- **Receipt correction below reserved:** request → affected orders (found by reading the open
  reservations of the item/location, id order) → reservations (id order) → reservation totals →
  balances (the receipt line lock of the existing correction comes before the balances, as today).
- **Restore coverage:** request → affected orders → reservations → reservation totals → balances.
- **Session takeover / release / heartbeat:** request → session → crate.

## 9. Database invariants

| Rule                                                                          | Enforcement                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one open cycle per crate                                                      | partial unique `crate_cycles(crate_id) WHERE status NOT IN ('ABORTED','CLOSED')`                                                                                                                                             |
| at most capacity bottles, never a 41st                                        | `CHECK ordinal BETWEEN 1 AND cycle_capacity`; composite FK (cycle_id, cycle_capacity) → crate_cycles(id, capacity); partial unique (cycle_id, ordinal) WHERE released_at IS NULL; insert only into `OPEN_ASSEMBLY` (trigger) |
| `READY_TO_FILL` ⇔ exactly capacity; `OPEN_ASSEMBLY` ⇒ fewer; `ABORTED` ⇒ none | commit-time constraint trigger on cycles and assignments                                                                                                                                                                     |
| a bottle in at most one active cycle                                          | partial unique `crate_assignments(bottle_id) WHERE released_at IS NULL`                                                                                                                                                      |
| all snapshots match                                                           | composite FK assignment → cycle (id, product, recipe, label); assignment → order (same columns); cycle → crate-type/category mapping; snapshot columns immutable                                                             |
| category bound forever                                                        | `bottle_category_bindings` PK bottle, insert-only; binding category = order product category (commit-time)                                                                                                                   |
| no eligibility while on hold                                                  | guards in every operation + commit-time check that no assignment is created for a bottle with an open hold                                                                                                                   |
| no double consumption                                                         | existing (one `LABEL_APPLIED` per bottle, movement ↔ event, protected balance) + `CONSUME` ↔ stock movement unique + order activation BOM (commit-time)                                                                      |
| no activation outside an order                                                | insert trigger: a new `LABEL_APPLIED` without production_order_id is refused (existing rows unaffected)                                                                                                                      |
| one active session per crate                                                  | partial unique `production_work_sessions(crate_id) WHERE status = 'ACTIVE'`                                                                                                                                                  |
| forward-only status                                                           | transition triggers on orders, cycles (the one supervised `READY_TO_FILL → OPEN_ASSEMBLY` step requires a `RETURNED_TO_ASSEMBLY` crate event in the same transaction), recipes, sessions                                     |
| actors present                                                                | `NOT NULL` actor columns referencing `users` on all new tables                                                                                                                                                               |

## 10. Idempotency and recovery

- **Order creation:** `client_request_id` unique; release, cancel, scan, removal, abort,
  reassignment, crate registration, label void/reprint, replacement, reservation correction and
  session operations each have their own operation kind. Same id + same payload → stored result
  (progress re-read, flagged `replayed`); different payload → `IDEMPOTENCY_CONFLICT`.
- **Lost scan response:** retry with the same request id replays; nothing is consumed twice.
- **Reload:** the server returns the operator's session; the scan field regains focus after the
  render that enables it (existing behaviour).
- **Scanner double read:** a new request id for the same bottle → `ALREADY_ASSIGNED` decided under
  the bottle lock, no write.
- **Continuing an open crate under another order:** the new session claims the crate (after the
  previous session was released, closed or taken over); the next scan continues the existing cycle
  only if all five snapshots match.

## 11. Reuse — what stays, what is composed, what must not be duplicated

- **Unchanged:** inventory ledger and balances, drift function, lots, receipts, suppliers,
  `OperationRequestsService`, QR policy (`classifyScannedQr`), `LABEL_APPLIED` / `LABELED_EMPTY`,
  LABEL component attachment, label templates and versions, renderer, creation-batch tables.
- **Extracted / composed:** `bottles.createBatch` → `createBatchInTransaction` (release creates
  order series atomically); print-job creation inside the release transaction; the activation core
  of `LabelApplicationService` becomes one in-transaction step composed by the production scan,
  reading the **recipe's** activation BOM; the series check (`WRONG_SERIES`, doc 019) generalizes to
  "identity belongs to one of the order's series".
- **Never duplicated:** stock posting path, BOM/component tables, QR parsing, idempotency.
- **Retired:** the standalone `POST /api/admin/label-applications` — permission-guarded
  (supervisor only) from the authentication PR, then `410 Gone` in the production-scan PR together
  with the database rule refusing `LABEL_APPLIED` without an order. `/production/label-activation`
  becomes a real redirect to `/production/orders`.

## 12. Permissions matrix

Permissions are checked server-side (deny by default); the UI only hides what the server would
refuse. `ADMIN` manages users, roles and configuration; it may execute any operational action
only as an **emergency override** with an explicit reason and an `EMERGENCY_OVERRIDE` audit event
— it is not the routine production approver.

| Permission                                  | PROD. OPERATOR | PROD. SUPERVISOR | WH. OPERATOR | WH. SUPERVISOR |   ADMIN    |
| ------------------------------------------- | :------------: | :--------------: | :----------: | :------------: | :--------: |
| `production:order_read`                     |       ✓        |        ✓         |              |                |     ✓      |
| `production:order_create` (draft)           |                |        ✓         |              |                | emergency  |
| `production:order_release`                  |                |        ✓         |              |                | emergency  |
| `production:order_cancel`                   |                |        ✓         |              |                | emergency  |
| `production:scan` (session, crate, bottles) |       ✓        |        ✓         |              |                | emergency  |
| `production:session_release_own`            |       ✓        |        ✓         |              |                |            |
| `production:session_takeover`               |                |        ✓         |              |                | ✓ (reason) |
| `production:defect_report`                  |       ✓        |        ✓         |              |                |            |
| `production:crate_remove_bottle`            |                |        ✓         |              |                | emergency  |
| `production:cycle_abort`                    |                |        ✓         |              |                | emergency  |
| `production:replacement_create`             |                |        ✓         |              |                | emergency  |
| `labels:item_void_single` + reprint request |       ✓        |        ✓         |              |                |            |
| `labels:item_void_bulk` / exceptional       |                |        ✓         |              |                | emergency  |
| `catalog:recipe_approve`                    |                |        ✓         |              |                | emergency  |
| `catalog:product_manage`, label approvals   |                |        ✓         |              |                | emergency  |
| `crates:register`, crate labels             |                |        ✓         |              |       ✓        |     ✓      |
| `crates:read` (internal detail)             |       ✓        |        ✓         |      ✓       |       ✓        |     ✓      |
| `inventory:receive`, supplier documents     |                |                  |      ✓       |       ✓        |            |
| `inventory:correct`                         |                |                  |              |       ✓        | emergency  |
| `inventory:correct_below_reserved`          |                |                  |              |       ✓        | emergency  |
| `inventory:reservation_resolve`             |                |                  |              |       ✓        | emergency  |
| `inventory:read`                            |       ✓        |        ✓         |      ✓       |       ✓        |     ✓      |
| `identity:users_manage`, roles, config      |                |                  |              |                |     ✓      |

"Single" label void = one unused, damaged label of an identity not yet activated (operator);
anything else (several items at once, an already activated identity, a whole series) is
bulk/exceptional and needs `PRODUCTION_SUPERVISOR`. Operators "perform assigned production work"
by working on orders released to production in their warehouse scope; per-operator assignment of
orders is not modelled in v0.1.

## 13. Migration plan

All migrations are additive; enum additions get their own migration (PostgreSQL enum values are
not usable in the transaction that adds them — same as Milestone 2A).

| #   | Migration               | Content                                                                                                                                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | identity                | users, user_identities, roles (seed), role_permissions (seed), user_roles, user_scopes, audit_events                                                                                  |
| 2   | enum values             | bottle events `ASSIGNED_TO_CRATE`, `REMOVED_FROM_CRATE`, `QUARANTINED`, `IDENTITY_VOIDED`, `REPLACEMENT_REQUESTED`; consumption stage `FILL`; print-job kind; new operation kinds     |
| 3   | catalog                 | product_categories (seed 2), products, product_label_approvals, recipe_versions, recipe_version_stages                                                                                |
| 4   | crates                  | crate_types (seed 2, capacity 40), crate_type_categories, qr_identities (+ copy of existing bottle tokens), crate_registrations, crates, crate label print jobs/items, crate_events   |
| 5   | orders and reservations | production_orders, production_order_series, inventory_reservations, reservation movements and totals (+ triggers), label_print_item_voids, print-job kind rule, bottle_identity_voids |
| 6   | work sessions           | production_work_sessions, production_session_events, partial unique indexes                                                                                                           |
| 7   | cycles and assignment   | crate_cycles, crate_assignments, bottle_category_bindings, bottle_holds, new nullable bottle_events columns, all commit-time checks, "LABEL_APPLIED only with an order"               |

**Existing data stays untouched.** New columns are nullable without backfill; bottle tokens are
copied into the registry (bottle rows unchanged). The 12 `CREATED` DEV identities and series
BC-000001…004 with their print jobs stay as they are — unassigned, unlinked; the production scan
refuses them (`NOT_IN_ORDER`). Receipt `GR-000001`, its lot, balance (5 000) and movement stay
unchanged; reservations start at 0. The legacy `LABEL_APPLICATION` v1 BOM stays for history.
Seeds contain only confirmed reference data (two product categories, two crate types with capacity
40, roles and permissions). No product, recipe, crate, order, cycle, assignment or user is
invented. "Cleaning" the DEV test identities before the pilot means **not carrying DEV data into
the pilot/production database**; DEV rows are never deleted (bottles reject DELETE).

## 14. Implementation sequence (one PR each, owner-authorized)

1. **Documentation and ADRs** — this document, ADR 0021 (supersedes ADR 0004), ADR 0022 (resolves
   ADR 0017's provider question); affected docs and CLAUDE.md updated.
2. **Authentication, users, roles, guards** — WorkOS AuthKit behind the provider boundary (subject
   to the pricing/DPA/EU data-location check before production), AYVO user mapping, roles and
   permissions, deny-by-default guards on every write endpoint, audit events; Basic Auth stays only
   the outer DEV gate; the standalone label-activation write becomes supervisor-only.
3. **Catalog and crates** — products, label approvals, recipes, crate types/registration/labels
   (migrations 2–4).
4. **Production orders and material reservations** — creation, release, cancellation with
   reconciliation, label void/reprint, receipt correction below reserved, real available stock
   (migration 5).
5. **Server-side work sessions** — open, heartbeat lease, resume, claim/release crate, takeover
   (migration 6).
6. **Atomic activation + crate assignment** — the production scan, removal, abort, reassignment,
   replacements, retirement of the standalone endpoint (migration 7); concurrency tests (60
   parallel scans into one crate → exactly 40 and `READY_TO_FILL`; two stations racing for one
   crate; two orders continuing one partial crate; reservations racing for the last units; receipt
   correction against concurrent scans).
7. **UI and E2E** — Výroba: Přehled výroby · Výrobní zakázky · **Bedny** · Lahve · Šablony
   etiket · Produkty a receptury; order list/creation/detail; the workstation with separate order
   progress (eligible n/planned) and crate progress (n/40) and lot remaining; Bedny list and detail
   (cycle history, ordinals, removal/abort); redirect of `/production/label-activation`; the
   existing four-width, wrapping and scanner-focus E2E standards.

## 15. Out of scope for Production Core v0.1

Filling and liquid/pump consumption (2B), the Quality workflow (hold resolution, scrap,
rework), short close and cancelling in-progress orders, per-operator order assignment, physical
crate slot grid, crate washing/damage/retirement workflows, picking, deliveries, PPL/carriers,
hotels and the hotel portal, returns and sorting, billing, sales and commissions, ESG/CO2e,
purchasing, full internationalization, production deployment.
