# 018 — Inventory foundation, supplier receiving and physical label application (Milestone 2A)

Status: **Approved by owner 2026-10-11 (revision 3)** — revision 2 plus the owner's decisions
and additions of 2026-10-11 (Czech warehouse UI, lot traceability of new bottles, invoice-pending
receipts, quantity precision, bottle as an assembly of components). This approval is the
domain-model approval required by CLAUDE.md for the models under "Implemented now".

Revision 2 replaces revision 1 (a singleton empty-bottle counter) with a reusable inventory
foundation, following the owner's authoritative clarification of 2026-10-11.

## 1. Domain concepts kept apart

| Concept                        | What it is                                                                                  | Module                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------- |
| Quantity inventory             | Anonymous stock of an **inventory item** in an explicit base unit (pieces, ml, g, sheets …) | `inventory`                  |
| Serialized reusable asset      | A bottle (later a crate) with its own identity, QR and lifecycle; **never** quantity stock  | `assets`                     |
| Product definition / BOM       | Versioned recipe: which items, how much, consumed at which stage                            | `inventory` (BOM)            |
| Supplier, documents, receiving | Who delivered what, with which document; the only way a purchase increases stock            | `procurement`\*              |
| Label design and print jobs    | Milestone 1 (unchanged): templates, immutable versions, print jobs and their items          | `labels`, `label-production` |
| Physical label application     | The warehouse scan that turns one anonymous new bottle into a labelled serialized bottle    | `warehouse`                  |

\* `procurement` starts with suppliers, supplier documents and receipts; purchase orders join it
later. Modules talk only through exported services (ADR 0001).

## 2. Quantities and units

- **Exact numbers only:** every quantity is PostgreSQL `NUMERIC(19,3)`; never floating point.
  In TypeScript quantities travel as decimal strings (Zod-validated) and are computed with
  Prisma's `Decimal`, never `number`.
- **`inventory_units`** (reference data): `code` (`pcs`, `ml`, `g`, `sheet`, `roll` …), name,
  `dimension` (`COUNT`, `VOLUME`, `MASS`, …) and `decimal_places` (`pcs` 0). A trigger rejects a
  quantity with more decimals than its unit allows (no 0.5 bottle).
- **One base unit per item, no implicit conversion:** every receipt line, movement, balance and
  BOM line of an item uses the item's base unit, enforced by a composite foreign key
  `(item_id, unit_id) → inventory_items(id, base_unit_id)`. Litres/kilograms on supplier
  paperwork are converted explicitly at entry by a later, versioned conversion table — never
  silently.
- **Decided (owner, 2026-10-11):** `NUMERIC(19,3)`, decimal strings in API contracts, pieces
  always whole, no implicit conversion; a liquid item uses `ml` or `g` as configured on that item.
  Recipes and the fill quantity are configurable data in 2B — **330 ml is never hard-coded**.

## 3. Tables and relationships

```text
inventory_units ◄── inventory_items ──► inventory_item_settings (versions: thresholds, supplier, lead time)
                         │   ▲
                         │   └── bom_lines ◄── bom_versions (scope: STAGE now, PRODUCT_VERSION later)
                         ▼
inventory_locations ◄── inventory_movements (append-only ledger) ──► inventory_balances (protected cache)
                         │ typed source (exactly one):
                         ├── goods_receipt_lines ◄── goods_receipts ──► suppliers
                         │        │                      └── goods_receipt_documents ──► supplier_documents (file)
                         │        └── inventory_lots (supplier lot, or internal lot of that line)
                         ├── goods_receipt_corrections ──► goods_receipt_lines
                         └── bottle_events (LABEL_APPLIED) ──► bottles   [assets]
bottle_component_attachments (assets): bottle ◄── LABEL (QR URL, print job item) · later PUMP (item, lot)
operation_requests (idempotency for every mutating operation)
```

### Implemented now (Milestone 2A)

| Table                          | Purpose and key rules                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_units`              | Reference data (seeded): `pcs`, `ml`, `g`, `sheet`, `roll`.                                                                                                                                                                                                                                                                                                                                                                 |
| `inventory_items`              | Catalogue entry; immutable identity: `code`, `kind` (`NEW_BOTTLE`, `PUMP`, `LABEL_MEDIA`, `BULK_LIQUID`, `PACKAGING`, `COMPONENT`), `base_unit_id`, `lot_tracking` (`NONE` / `REQUIRED`); `name`; `archived_at`. **Creating an item is never a receipt.**                                                                                                                                                                   |
| `inventory_item_settings`      | Append-only versions (`valid_from`): reorder point, target level, preferred supplier, lead time (days), purchase multiple. Current = latest version.                                                                                                                                                                                                                                                                        |
| `inventory_locations`          | Seeded with one location `MAIN` (the physical warehouse). Every movement and balance names a location.                                                                                                                                                                                                                                                                                                                      |
| `suppliers`                    | Name, optional company registration and VAT id, `archived_at`. Created by an administrator, never inside a receipt.                                                                                                                                                                                                                                                                                                         |
| `supplier_documents`           | Immutable: `kind` (`INVOICE`, `DELIVERY_NOTE`, `OTHER_APPROVED`), number, issue date, file (storage key, SHA-256, size, content type, original name) via `FileStorage` namespace `supplier-documents`. Corrections are new documents (`supersedes_id`).                                                                                                                                                                     |
| `inventory_lots`               | Lot of a lot-tracked item. `kind` `SUPPLIER` (`(item, supplier, supplier_lot_code)` unique; several receipts may deliver the same supplier lot) or `INTERNAL` (created for one receipt line when the supplier gives no lot; code `GR-000001/1`, unique per line). Optional expiry.                                                                                                                                          |
| `goods_receipts`               | `GR-000001`; supplier, supplier reference, `received_at`, type `PURCHASE` (only type now), note, request id. **Created already confirmed, immutable.**                                                                                                                                                                                                                                                                      |
| `goods_receipt_lines`          | Item, unit (= base unit), quantity > 0, lot (required iff the item is lot-tracked), optional `unit_price` + `currency` (both or neither) + `vat_rate`.                                                                                                                                                                                                                                                                      |
| `goods_receipt_documents`      | Append-only links receipt ↔ supplier documents (`linked_at`, `actor_id`, request id). A `PURCHASE` receipt needs at least one `INVOICE` or `DELIVERY_NOTE` at confirmation (deferred constraint trigger). Without a linked `INVOICE` the receipt is **invoice pending** (derived, filterable): stock is available, the purchasing record is not financially complete. The invoice is linked later; links are never removed. |
| `goods_receipt_corrections`    | Append-only compensating entries on a receipt line: signed quantity ≠ 0, reason required, request id.                                                                                                                                                                                                                                                                                                                       |
| `inventory_movements`          | The ledger (below). Append-only.                                                                                                                                                                                                                                                                                                                                                                                            |
| `inventory_balances`           | Current on-hand per `(item, location, lot)`; written **only** by the ledger trigger.                                                                                                                                                                                                                                                                                                                                        |
| `bom_versions`, `bom_lines`    | Versioned consumption rules. Now: one stage rule `LABEL_APPLICATION` v1 = 1 `pcs` of the new-bottle item. Later: product recipes (pump, configured liquid quantity, label media) with stage `FILL`.                                                                                                                                                                                                                         |
| `bottle_component_attachments` | Installation history of replaceable components of a bottle (section 15). Now: `LABEL` attachments created by label application.                                                                                                                                                                                                                                                                                             |
| `operation_requests`           | `request_id` (PK), operation kind, SHA-256 of the canonical payload, result reference, created at.                                                                                                                                                                                                                                                                                                                          |

Seeded reference data (migration, not a receipt): units, location `MAIN`, item
`NEW_BOTTLE` "Nová prázdná lahev" (`pcs`, **lot tracking required**), BOM `LABEL_APPLICATION` v1.
**No supplier, no stock, no lots, no receipts are seeded.**

**Lot rule for new bottles (owner, 2026-10-11):** every received `NEW_BOTTLE` line gets a lot —
the supplier lot when provided, otherwise an internal lot tied to that receipt line. Balances are
kept per lot, so every consumed bottle body is traceable to its receipt line and supplier lot.

### Deliberately deferred (the schema leaves room; no tables or screens yet)

See also section 16 for the deferred component workflows and their extension points.

Purchase orders and lines (`goods_receipt_lines.purchase_order_line_id` added later), reservations,
on-order and demand forecasting, unit conversions, product catalogue and product BOMs, pumps and
liquid consumption, filling, crates, damage/waste/write-off/stocktake/transfer movements, label
media consumption at printing, external label printers, finance data on invoices, sales,
commissions, authentication and roles.

## 4. The ledger and the protected balance

`inventory_movements`: item, location, lot (nullable), unit, `quantity_delta` (exact, ≠ 0),
`movement_type`, **typed source** (exactly one source column set), `balance_after`,
`occurred_at`, `recorded_at`, `actor_id` (NULL until authentication), `request_id`.

| `movement_type`                                                                                              | Sign | Required source                   | Now / later |
| ------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------- | ----------- |
| `RECEIPT`                                                                                                    | +    | `goods_receipt_line_id`           | now         |
| `RECEIPT_CORRECTION`                                                                                         | ±    | `goods_receipt_correction_id`     | now         |
| `LABEL_APPLICATION`                                                                                          | −    | `bottle_event_id` + `bom_line_id` | now         |
| `FILL_CONSUMPTION`, `PROCESS_VARIANCE`, `DAMAGE`, `WRITE_OFF`, `TRANSFER`, `RETURN_TO_SUPPLIER`, `STOCKTAKE` | ±    | own source tables                 | later       |

Database guarantees:

| Invariant                                         | Enforcement                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger is history                                 | UPDATE/DELETE/TRUNCATE rejected (trigger)                                                                                                                         |
| Balance = Σ ledger                                | `BEFORE INSERT` trigger on movements upserts the balance row and sets `balance_after`; balances reject writes not coming from that trigger (`pg_trigger_depth()`) |
| Stock never negative                              | `CHECK (on_hand >= 0)` on balances — an overdraw aborts the whole transaction                                                                                     |
| Type ⇔ sign ⇔ source                              | CHECK constraints per `movement_type`                                                                                                                             |
| Units never mixed                                 | composite FKs to the item's base unit; decimal-places trigger                                                                                                     |
| A receipt line posts exactly once                 | unique `goods_receipt_line_id` among `RECEIPT` movements                                                                                                          |
| A stage event consumes each BOM line once         | unique `(bottle_event_id, bom_line_id)`                                                                                                                           |
| Receipts, lines, documents, corrections immutable | triggers; document links insert-only                                                                                                                              |
| A receipt line never corrected below zero         | trigger: line quantity + Σ its corrections ≥ 0 (line row locked)                                                                                                  |
| Lots only for lot-tracked items                   | trigger: `lot_id` NOT NULL ⇔ item `lot_tracking = REQUIRED`                                                                                                       |

`on hand` = Σ ledger (the balance). `reserved` = 0 until reservations exist. `available` =
on hand − reserved. `on order`, `expected demand` and `suggested replenishment` are computed,
never stored as stock; purchase orders, invoices and forecasts never move stock.

## 5. From quantity stock to a serialized bottle

```text
quantity item NEW_BOTTLE (pcs, MAIN)            serialized asset (assets module)
      on hand 10 000
           │  physical label application scan (one transaction)
           │  −1 pcs LABEL_APPLICATION ───────────►  bottle CREATED → LABELED_EMPTY
           ▼                                            + event LABEL_APPLIED
      on hand  9 999                                     (UI: "Etiketa nalepena – prázdná lahev")
```

The anonymous unit ceases to exist as stock at the same instant the serialized bottle becomes
physical; the movement references the `LABEL_APPLIED` event and the BOM line that required it, so
every consumed unit points to exactly one bottle and vice versa. Later, filling consumes the
product BOM (pump, the configured liquid quantity — currently 330 ml as recipe data, …) against
the `FILLED` event in the same way; nominal consumption and measured variance are separate
movements.

**Facts about a bottle, all distinct:** identity created (`CREATED` event) · present in a print
job (job item) · print job `COMPLETED` (label rendered for printing) · label physically applied
(`LABEL_APPLIED` + an open `LABEL` component attachment). Creating an identity or printing
consumes no bottle stock. The `LABEL_APPLICATION` movement names the **exact lot** the operator
selected for the session, so the chain is: receipt line → lot → movement → `LABEL_APPLIED` event →
bottle.

## 6. Labels without double counting

| Thing                                      | Representation                                                                                          | Quantity stock?           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| Digital QR identity                        | `bottles` row (one per identity)                                                                        | no                        |
| Print job item                             | `label_print_job_items` (identity × job; reprints add items, never identities)                          | no                        |
| Unique printed QR label                    | identified by its exact QR URL from a `COMPLETED` job; at most one can ever be **applied** per identity | **no** — identity-tracked |
| Blank label media (sheets, rolls)          | inventory item `LABEL_MEDIA` (`sheet`/`roll`); consumed by a future `PRINT` stage per print run         | yes (later)               |
| Pre-printed labels from an outside printer | tracked as print jobs sent to and returned from that printer (later), never as anonymous stock          | no                        |
| Label applied to a bottle                  | `LABEL_APPLIED` event (+ status `LABELED_EMPTY`)                                                        | no                        |

A unique QR label is never quantity stock: counting it would duplicate the identity. Blank
media leave stock when printed, not when applied, so nothing is deducted twice. Label application
consumes **zero** label stock and exactly one `NEW_BOTTLE`.

The physical label is recorded as a `LABEL` component attachment: the exact scanned QR URL and the
print job item it came from. A scan identifies the **identity**, not the printed sheet: reprints of
one identity carry the same QR URL (the URL is stable for the bottle's lifetime, ADR 0014) and are
physically indistinguishable. The attachment therefore references the most recent `COMPLETED`
print job item of that identity at installation; the database checks that this item belongs to
the same bottle and carries exactly the scanned URL.

## 7. Label application scan — transaction and locking order

Input: `POST /api/admin/label-applications { requestId, lotId, scannedValue }` — `lotId` is the
lot the operator selected for the working session (section 10). Only trailing/leading
CR, LF and whitespace (scanner terminators) are removed; host, path, token and case are never
rewritten. Accepted only: exactly `PUBLIC_QR_BASE_URL + "/" + token` of this environment.

1. Validate input without database access (reject `NOT_AYVO_QR`, `WRONG_ENVIRONMENT`).
2. `BEGIN`. Insert `operation_requests(request_id, 'LABEL_APPLICATION', payload_hash)`.
   On conflict: same hash → return the stored result; different hash → `IDEMPOTENCY_CONFLICT` (409).
   (A concurrent duplicate waits on the unique index, then reads the stored result.)
3. Find the bottle by token; verify the exact URL is an item of a `COMPLETED` print job
   (`UNKNOWN_LABEL`, `LABEL_NOT_PRINTED`).
4. `SELECT … FROM bottles WHERE id = $1 FOR UPDATE`.
   `LABELED_EMPTY` → `ALREADY_APPLIED` (stored, no movement). Not `CREATED` → `NOT_APPLICABLE`.
5. Read the active `LABEL_APPLICATION` BOM version (immutable rows); the selected lot must be a
   lot of its `NEW_BOTTLE` line (`WRONG_LOT`).
6. Lock the balance row of exactly that `(item, MAIN, lot)` (`SELECT … FOR UPDATE`); if
   `on_hand` < required → `LOT_EXHAUSTED`, `ROLLBACK`. **No other lot is ever tried** (no FIFO,
   no silent switch).
7. Insert `LABEL_APPLIED` event, set status `LABELED_EMPTY`, open the `LABEL` component
   attachment, insert one movement per BOM line with the selected lot (trigger updates balances;
   CHECK is the backstop).
8. Store the result on the operation request. `COMMIT` (deferred triggers verify event ⇔ status ⇔
   movement ⇔ label attachment).

Global lock order for every operation: `operation_requests` → asset rows (by id) → receipt lines
(by id) → balances (by item, location, lot). Receipts and corrections follow the same order, so
concurrent operations cannot deadlock.

Rejections (`LOT_EXHAUSTED`, `UNKNOWN_LABEL` …) roll back completely, including the request row,
so a retry after the cause is fixed works with the same request id. Only successful outcomes
(`APPLIED`, `ALREADY_APPLIED`) are stored.

| Outcome                | HTTP | Meaning                                                  |
| ---------------------- | ---- | -------------------------------------------------------- |
| `APPLIED`              | 200  | One new bottle consumed; bottle now `LABELED_EMPTY`      |
| `ALREADY_APPLIED`      | 200  | Label applied earlier; zero stock consumed               |
| `NOT_AYVO_QR`          | 422  | Not an AYVO QR URL                                       |
| `WRONG_ENVIRONMENT`    | 422  | AYVO URL of another environment (e.g. production on DEV) |
| `UNKNOWN_LABEL`        | 422  | Well-formed URL, no such identity                        |
| `LABEL_NOT_PRINTED`    | 422  | Identity exists, never in a `COMPLETED` print job        |
| `NOT_APPLICABLE`       | 422  | Bottle in a later state (future phases)                  |
| `LOT_EXHAUSTED`        | 409  | The selected lot has no bottle left; select another lot  |
| `WRONG_LOT`            | 422  | The selected lot is not a new-bottle lot                 |
| `IDEMPOTENCY_CONFLICT` | 409  | Request id reused with a different payload               |

## 8. Idempotency and concurrency

- Every mutating request (receipt, correction, label application, document upload, supplier
  creation) carries a client `requestId`; `operation_requests` stores the payload hash and result.
  Same id + same payload → the original result; same id + different payload → 409, never another
  operation's result.
- Last unit of a lot, two different bottles scanned concurrently → the balance row lock
  serializes them: exactly one `APPLIED`, one `LOT_EXHAUSTED`, balance 0, no stray event.
- Same bottle scanned concurrently → bottle row lock: one `APPLIED`, the other `ALREADY_APPLIED`,
  one movement.
- Receipt confirmation inserts header, lines, document links and `RECEIPT` movements in one
  transaction; a lost response is retried with the same id.

## 9. Existing DEV data

AYV-B-000001…000012 stay `CREATED` (identity, completed print job, **not** applied). No backfill
of `LABEL_APPLIED`, no invented stock or suppliers. The migration only adds enum values, tables,
triggers and reference rows; no existing row changes. Physical application on DEV requires a real
receipt first.

## 10. Warehouse workflows (UI)

> **Amended by [doc 019](019-app-shell-and-information-architecture.md) / ADR 0020 (2026-10-11):**
> label application belongs to **Výroba** (Production) at `/production/label-activation`
> (`/warehouse/labels` redirects there) and its session also binds a bottle series (server-side
> `WRONG_SERIES`). `/warehouse` is the warehouse overview. The whole internal application is now
> Czech, including bottle and template pages. The workflow descriptions below remain valid.

New top-level **Sklad** — warehouse and operator screens are **Czech** (owner, 2026-10-11): each
screen is linguistically consistent; strings live in a separate Czech dictionary
(`apps/web/src/i18n/cs`), not in components or domain logic, so the screens are translation-ready.
Existing administration stays English for now. Internal codes, SKUs and state values stay
language-neutral; `LABELED_EMPTY` is shown as "Etiketa nalepena – prázdná lahev".

- **Apply labels / Nalepení etiket** (`/warehouse/labels`, default): first **select the active
  source lot** for the session (list of new-bottle lots with stock; or type its code) — shown
  large with its remaining quantity during scanning. Switching lots is an explicit action; an
  exhausted lot stops scanning with "Šarže je vyčerpaná – vyberte další šarži", never switches by
  itself. Then one full-width scan field (autofocus; Enter submits; field clears and refocuses
  after every result). States: ready · checking · applied (green: code, "1 new bottle used",
  remaining) · already applied (amber, "no stock used") · rejected (red: reason and what to
  do) · lot exhausted · network error (retry, same request id). Last 20 results of the session.
  Phone and scanner widths, large touch targets.
- **Receive goods** (`/warehouse/receipts/new`): supplier (existing only) → delivery/invoice
  reference and receipt date → attach document(s) (upload PDF/JPEG/PNG, kind, number, date) →
  lines (item, quantity in its base unit, supplier lot code — empty means an internal lot is
  created, optional price/currency/VAT) → review
  → confirm once → receipt `GR-…` with new stock levels.
- **Stock** (`/warehouse/stock`): per item at `MAIN`: on hand, reserved (0), available, reorder
  point, target, low-stock warning and suggested quantity (target − available, rounded up to the
  purchase multiple; a suggestion only, nothing is ordered); item ledger.
- **Receipts** (`/warehouse/receipts`, `/warehouse/receipts/[code]`): history (filter **invoice
  pending**), lines with lots, documents (download through the API only; **attach invoice** later,
  append-only), corrections; **Correct line** (reason required) — a warehouse-manager action.
- **Administration** (minimal): suppliers (create, archive), item planning settings (new
  version). No generic stock editing anywhere; no edits of receipts, movements or events.
- Bottle detail (English admin) shows "Label applied" with time, source lot and receipt, and the
  component history, as facts separate from creation and printing.

## 11. Roles

> **Updated 2026-10-11:** the provider is decided (external OIDC, ADR 0022) and the role and
> permission matrix for warehouse and production is in [doc 020 §12](020-production-core-v0.1.md)
> (`WAREHOUSE_OPERATOR`, `WAREHOUSE_SUPERVISOR`, `PRODUCTION_*`, `ADMIN`). Receipt corrections that
> reduce stock below reserved quantities need `WAREHOUSE_SUPERVISOR`, an impact preview and a
> reason (doc 020 §5). The table below is the original 2A tagging.

Now (DEV): no application authentication; the whole site sits behind Basic Auth (ADR 0013), so
every user is effectively an administrator. **This is not authorization**; it blocks production
(ADR 0017). Every endpoint is tagged in this document with the permission it will need, so guards
are mechanical once authentication exists:

| Permission (future)            | Endpoints / screens                                             | Roles                                                                                |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `warehouse.label.apply`        | label application scan (→ `production.label.apply`, doc 019 §5) | warehouse operator, manager                                                          |
| `inventory.receive`            | receive goods, upload supplier documents                        | warehouse operator, manager                                                          |
| `inventory.correct`            | receipt corrections                                             | warehouse manager                                                                    |
| `inventory.read`               | stock, ledger, receipts (quantities)                            | operator (own workflows), manager, procurement, sales (availability), finance, admin |
| `inventory.read.prices`        | unit prices, currency, VAT on receipt lines                     | procurement, finance, admin                                                          |
| `inventory.items.manage`       | items, planning settings                                        | administrator (procurement: settings)                                                |
| `procurement.suppliers.manage` | suppliers                                                       | administrator, procurement                                                           |

Later roles (owner, 2026-10-11): warehouse operator, warehouse manager, procurement, sales
representative, sales manager, finance, administrator, hotel user (read-only own hotel, never
scans). Authorization is server-side; hidden buttons are not authorization. Authentication and RBAC
are a **required phase before broader operational or external use** (roadmap below).

## 12. Implemented now vs. deferred

Now: units, items (+ settings versions), `MAIN`, suppliers, supplier documents (upload,
immutable, API-only download), lots (supplier and internal; new bottles lot-tracked), receipts
with lines and append-only document links (purchase type only; invoice-pending status), receipt
corrections, ledger + protected balances, low-stock warning and suggestion, stage BOM
`LABEL_APPLICATION`, label application scan with session lot, `LABELED_EMPTY` / `LABEL_APPLIED` /
`LABEL_APPLICATION`, `LABEL` component attachments, operation requests, Czech warehouse screens,
bottle detail facts.

Deferred: everything in section 3 "Deliberately deferred" and the roadmap below.

## 13. Migration, rollback and recovery

- **Forward:** two additive migrations. (1) enum values `LABELED_EMPTY`, `LABEL_APPLIED` (a new
  enum value cannot be used in the transaction that adds it); (2) new tables, constraints,
  triggers, code counter `GR`, reference rows. Applied only through `scripts/deploy-dev.sh`
  (pre-migration `pg_dump`, `prisma migrate deploy`).
- **Rollback before any physical application:** redeploy the previous images; the extra tables
  are unused (additive).
- **Rollback after applications or receipts exist:** the previous code cannot read
  `LABELED_EMPTY` bottles. Recovery is a forward fix, or a restore of the pre-migration dump
  **together with** the files volume (supplier documents live in file storage, not in the dump —
  ADR 0016). Restores lose all later receipts and applications, so forward fixes are preferred.
- No migration ever rewrites ledger or event rows.

## 14. Tests proving stock cannot drift or go negative

- Database level: direct balance writes rejected; ledger/receipt/document/correction updates and
  deletes rejected; wrong type/sign/source combinations, mixed units and fractional pieces
  rejected; overdraw rejected by the CHECK.
- Invariant helper: Σ ledger = balance for every `(item, location, lot)`; run after every
  inventory test and after the stress tests.
- Concurrency: 50 parallel scans of different bottles with 10 in the selected lot → exactly 10
  `APPLIED`, 40 `LOT_EXHAUSTED`, balance 0, 10 events, 10 movements, 10 attachments, other lots
  untouched; 20 parallel scans of one bottle → 1
  `APPLIED`, 19 `ALREADY_APPLIED`, 1 movement; correction racing applications never below zero.
- Randomised sequence (seeded) of receipts, corrections and scans against an in-memory model:
  final balance and ledger equal the model.
- Idempotency: replay → same result; same id + different payload → 409; `LOT_EXHAUSTED` not cached.
- Traceability: every `LABEL_APPLICATION` movement → its lot → receipt line; every applied bottle
  has exactly one open `LABEL` attachment whose print job item belongs to it.
- Playwright: supplier → receipt with uploaded delivery note → stock → scan (Enter) applied,
  duplicate, wrong-environment, unknown, no-stock → bottle detail shows the fact; phone width.

## Roadmap additions (to be mirrored in doc 014)

> **Superseded 2026-10-11** by the roadmap in doc 014 and the Production Core sequence (doc 020
> §14): authentication first, then catalog/crates, orders and reservations, work sessions, the
> atomic production scan (activation + crate assignment), UI. The standalone label application of
> 2A is retired once the production scan exists. The list below is kept for history.

1. **2A (this):** inventory foundation, receiving, label application.
2. **Authentication and RBAC** — required before operational/external use; roles above.
3. **2B:** products and versioned BOMs (330 ml is BOM data, not a constant), pumps and liquids
   received with lots, filling consuming the BOM atomically with `FILLED`, measured variance as
   its own movement.
4. **Crates** (serialized), then deliveries, returns, washing.
5. **Purchasing:** replenishment requests, purchase orders, on-order, receipts linked to PO lines.
6. **Sales and commissions:** effective-dated salesperson ↔ hotel assignments (immutable
   history), versioned commission plans, auditable commission claims, team views; commission
   basis pending decision (recommendation: collected revenue); margins shown only as labelled
   estimates until a cost methodology is approved.

## Implementation (Milestone 2A, 2026-10-11)

Modules: `inventory` (no controller; depends on no domain module) ← `procurement` (suppliers,
documents, receipts); `warehouse` composes `assets`, `label-production`, `inventory` and
`procurement` through their exported services. Idempotency: `OperationRequestsService` (database
module) wraps every mutating operation in one transaction with the `operation_requests` row.

Admin API (all under `/api/admin`, Zod contracts in `packages/types`: `inventory.ts`,
`procurement.ts`, `warehouse.ts`):

| Endpoint                                                               | Purpose (future permission)                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET/POST suppliers`, `POST suppliers/:id/archive`                     | suppliers (`procurement.suppliers.manage`)                     |
| `POST supplier-documents` (multipart), `GET …/:id/content`             | upload / download a supplier document (`inventory.receive`)    |
| `GET suppliers/:id/documents`                                          | documents of a supplier                                        |
| `GET/POST goods-receipts`, `GET goods-receipts/:code`                  | receipts; `?invoice=pending` filter (`inventory.receive/read`) |
| `POST goods-receipts/:code/documents`                                  | append a document, e.g. the invoice (`inventory.receive`)      |
| `POST goods-receipts/:code/corrections`                                | compensating correction (`inventory.correct`)                  |
| `GET inventory/items`, `POST inventory/items/:code/settings`           | items, planning-settings versions (`inventory.items.manage`)   |
| `GET inventory/stock`, `GET inventory/lots`, `GET inventory/movements` | stock, lots, ledger (`inventory.read`)                         |
| `POST label-applications`, `GET label-applications`                    | the scan; recent applications (`warehouse.label.apply`)        |
| `GET bottles/:code/physical`                                           | label application, source lot/receipt, component history       |

Czech screens (placement since doc 019: `/warehouse` overview, label application at
`/production/label-activation`): `/warehouse/labels` (redirect), `/warehouse/receipts/new`,
`/warehouse/receipts`, `/warehouse/receipts/[code]`, `/warehouse/stock`, `/warehouse/movements`,
`/warehouse/suppliers`; strings in `apps/web/src/i18n/cs/warehouse.ts`.

Findings of the final consistency check (SQL scenarios against the migrated schema, before
anything reached DEV), now covered by tests:

- The balance trigger first ensures the row exists (at 0) and then applies the delta with a plain
  `UPDATE`: an upsert cannot post a consumption, because PostgreSQL checks the CHECK constraint on
  the proposed insert row (the bare negative delta) before `ON CONFLICT` applies.
- `inventory_lots.origin_receipt_line_id` is a deferrable foreign key: an internal lot and its
  receipt line are created in the same transaction.
- The label attachment trigger also requires the print job to be `COMPLETED` (not only the API).

Independent pre-merge review (2026-10-11), fixed before merge with regression tests:

- Lot codes are unique per `(item, supplier, supplier lot code)` only — two suppliers may use the
  same lot code (it was wrongly unique per item, returning HTTP 500). Typing an ambiguous lot code
  on the scan screen asks the operator to choose from the list instead of guessing.
- The "exactly one complete label-application consumption" rule is also checked at commit for
  every later `LABEL_APPLICATION` movement, so nothing can be added to a committed application.
- Unit price (≤ 15 integer digits, 4 decimals, ≥ 0), VAT (0–100, needs a price) and the receipt
  date (2020-01-01 … now) are validated by the API instead of surfacing database errors.

Follow-ups (non-blocking): a domain exception filter for unexpected database errors; idempotent
re-upload of supplier documents; a typed installing event for future label replacements; a
narrower posting flag than `pg_trigger_depth()` for the balance guard (both are owner-bypassable
only through DDL).

## 15. The bottle as an assembly of replaceable components

A bottle in circulation is an assembly: **serialized bottle body** (carries the identity, the QR
token and the passport) · **physical label** · **pump** · **liquid fill**. The identity belongs to
the body only — never to a pump, a label or the liquid — and is never transferred to another body.

`bottle_component_attachments` (assets module) records every installation and removal:

| Column                                                                     | Meaning                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bottle_id`, `component_type`                                              | `LABEL` now; `PUMP` (and others) later                                                                  |
| `label_qr_url`, print job item                                             | for `LABEL`: exact scanned URL + `(print_job_id, position)` of the label's print job item (same bottle) |
| `inventory_item_id`, `lot_id`                                              | for consumable components (pump) later                                                                  |
| `installed_at`, `installed_by`, installation event                         | when/who; the bottle event that installed it (`LABEL_APPLIED` now)                                      |
| `removed_at`, `removed_by`, `removal_reason`, `disposition`, removal event | set once when removed; afterwards immutable                                                             |

Database rules: at most one open attachment per `(bottle, component_type)` (partial unique
index); rows are insert-only except a single close (removal fields from NULL to values); type-shape
CHECKs; the print job item of a `LABEL` must belong to the same bottle and carry the same URL.
Dispositions (enum, for removals later): `REUSED`, `SCRAPPED`, `QUARANTINED`, `CLEANING_REQUIRED`,
`RETURNED_TO_SUPPLIER`.

Label application is the **first `LABEL` installation**. A later label replacement closes it
(`REPLACED`/damaged reason, disposition `SCRAPPED`) and opens a new attachment for the same bottle
— both labels stay in the history; nothing is overwritten.

## 16. Deferred component workflows and their extension points

| Workflow (deferred)           | Behaviour (owner, 2026-10-11)                                                                                                                                                                    | Extension point                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Label replacement             | Body stays active; no new identity, no bottle stock; replacement label printed for the **same** token/passport; old attachment closed as damaged/replaced; print and installation audited        | new event `LABEL_REPLACED`; print job flagged as replacement; attachment close + open in one transaction          |
| Label media consumption       | Printing a label consumes one unit of label media; applying it consumes nothing                                                                                                                  | stage `PRINT` BOM + movement sourced from the print job                                                           |
| Pump installation/replacement | Pump consumed from stock once, when installed; a damaged pump is removed with `SCRAPPED` and **not** deducted again; the new pump is consumed when installed                                     | `PUMP` attachments with item + lot; movement sourced from the installation event                                  |
| Filling                       | Product BOM consumed atomically with `FILLED` (pump, configured liquid quantity); measured variance as separate movement                                                                         | stage `FILL` BOM lines; `FILL_CONSUMPTION`, `PROCESS_VARIANCE` movements                                          |
| Body damaged                  | Bottle identity permanently retired; no filling/dispatch; identity never moved to another body; detachable components inspected separately; reusable ones return to stock only after explicit QC | `RETIRED`/`DISPOSED` (ADR 0011) + per-component removals with dispositions; QC-gated `COMPONENT_SALVAGE` movement |
| Complete assembly write-off   | Guided operation producing explicit per-component dispositions; history preserved                                                                                                                | one transaction closing all open attachments + bottle retirement                                                  |
| Liquid remainder on return    | Never returns to usable stock automatically; disposition recorded separately (empty, waste, quarantine, measurement-only ESG data)                                                               | return-inspection record with liquid disposition; no inventory movement into usable stock                         |

## 17. Production blocker: durable secondary identity on the body

A damaged or missing primary label makes a bottle physically unidentifiable. Before production,
a durable secondary identity on the bottle body must be chosen and validated — preferably a small
permanent QR/DataMatrix, or a durable human-readable bottle code — resolving to the same identity
and not confusable with the product label. Until then, an unidentified returned bottle goes to
**quarantine** and is **never** matched by guessing from a crate, hotel or delivery record.
(Added to the production-blocker list in doc 016.)

## Decisions (owner, 2026-10-11)

1. **UI language:** warehouse/operator screens in Czech now, each screen consistent, strings in a
   separate dictionary; English administration may stay for now; full internationalization is
   required before external European rollout; codes, SKUs and state values stay neutral.
2. **Lot traceability:** new bottles are lot-tracked — supplier lot when provided, otherwise an
   internal lot per receipt line; the operator selects the active lot once per session; no FIFO
   guessing, no silent lot switch; active lot and remaining quantity always visible.
3. **Receipt documents:** invoice **or** delivery note confirms a receipt; delivery-note-only
   receipts are visibly **invoice pending**, filterable, invoice attachable later (append-only);
   warehouse work is not blocked.
4. **Quantities:** `NUMERIC(19,3)`, decimal strings, whole pieces, no implicit conversions, `ml`
   or `g` per liquid item; recipes and fill quantity configurable in 2B, never hard-coded.
