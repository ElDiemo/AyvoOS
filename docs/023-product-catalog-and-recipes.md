# 023 — Product catalogue and recipes (BOM) — application core v0.1

Status: **Implemented on branch `feat/product-catalog-bom-core`** (owner request 2026-10-13):
database, API and tests. **No administration UI, no stock movement.** This is the catalogue part
of [doc 020](020-production-core-v0.1.md) §14 step 3 ("Catalog and crates"), limited to crate
types; product-label approvals, crate registration and crate labels follow later (§10).

## 1. Business model (owner, 2026-10-13)

- **Components:** glass bottle 330 ml, pump, label, liquid, shipping box, returnable production
  crate.
- **Products:** "Tekuté mýdlo 330 ml" (category `HAND_SOAP`) and "All-in-one sprchový gel 330 ml"
  (category `SHOWER_GEL`) — created through the API, never seeded.
- **One finished bottle needs:** 1 glass bottle, 330 ml of the matching liquid, 1 pump and
  1 matching label.
- **Returnable production crate:** capacity 40 (data on the crate type, ADR 0021).
- **Shipping box:** its capacity is **not known** — it stays unknown (`null`), never guessed.
- Base units in this phase: `pcs` (shown as "ks") and `ml`. Quantities are exact
  (`NUMERIC(19,3)` / decimal strings), never floating point.
- The catalogue holds **no physical stock**; stock stays in the ledger of each site's warehouses.

## 2. Decision: a company-wide catalogue, site-bound stock

The catalogue is **global** (no site column), which matches the confirmed model:

- inventory items — which components are — are already company-wide (doc 018); label templates
  are company-wide brand data (doc 021 §4, `production:templates_manage`);
- doc 022 binds **operational** records (warehouses, receipts, stock, series, bottles, print jobs)
  to a site; master data that says _what_ a product is made of is not operational;
- doc 020 §3.3 defines products and recipes without a site.

What a site owns stays where it is: stock, lots, movements and balances belong to a warehouse of
a site, and every future consuming operation (production order, reservation, filling) will belong
to a site and act on its warehouse (doc 022). The catalogue API returns no stock, location or site
data, so it cannot weaken site isolation; a user of any site with `catalog:read` sees the same
catalogue.

## 3. Domain model

Mapping to the approved design (doc 020 §3.3): **recipe version = "verze kusovníku"**. Its
components are `bom_lines` of recipe-owned `bom_versions` — there is **no second component table**
(doc 020 §11). Doc 020's statuses `APPROVED`/`RETIRED` are named `ACTIVE`/`ARCHIVED` (the owner's
terms); the rules are the same.

| Table                   | Purpose and rules                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_categories`    | `HAND_SOAP` "Tekuté mýdlo", `SHOWER_GEL` "Sprchový gel" — confirmed reference data (doc 020), seeded; a table, so a third category needs no enum migration. Immutable.                                                                               |
| `inventory_items`       | (existing, doc 018) the component itself: code, name, kind, base unit, lot tracking. New items are created by the catalogue — never a receipt (no lot, movement or balance).                                                                         |
| `catalog_components`    | the catalogue profile of an item (1:1): `category_code` (the category it is made for; **required** for liquids and labels, `NULL` = any category), `package_capacity` (packaging only; `NULL` = unknown). Immutable.                                 |
| `crate_types`           | returnable crate type: code, name, **capacity** (1–1000, data — never a constant), immutable (crates module, doc 020 §3.4).                                                                                                                          |
| `crate_type_categories` | the categories a crate type carries (at least one, checked at commit). Insert-only.                                                                                                                                                                  |
| `products`              | code (`^[A-Z0-9][A-Z0-9_-]{1,23}$`), name, category (immutable), nominal quantity + unit (e.g. 330 ml — product data, separate from the recipe's liquid line). Immutable.                                                                            |
| `recipe_versions`       | per product: `version` 1–9999, `status` `DRAFT`/`ACTIVE`/`ARCHIVED`, `based_on_id` (copied from, same product), created/activated/archived by and at. A copy of the product's category (composite FK) lets the database check components and crates. |
| `recipe_revisions`      | the content of a version at one revision: crate type (nullable in a draft) + its stage BOMs. **Insert-only**; a draft edit appends the next revision; the highest one is current and is frozen by activation.                                        |
| `recipe_revision_boms`  | per revision and stage one recipe-owned `bom_versions` row (code `R-<PRODUCT>-V<n>-LA`/`-FL`, version = revision). A BOM belongs to at most one revision, ever.                                                                                      |

Every new table carries `created_by` (→ `users`, NOT NULL) and `operation_request_id`
(→ `operation_requests`) — doc 020 §3.1.

**Stages** (doc 020 §3.3): the bottle body and the label belong to `LABEL_APPLICATION`, the liquid
and the pump to `FILL` (new enum value). Nothing consumes either stage in this phase.

**One finished bottle (complete recipe):** exactly one line of each kind `NEW_BOTTLE`,
`LABEL_MEDIA`, `BULK_LIQUID`, `PUMP` — quantities are recipe data (330 ml is never a constant) —
and a crate type. The owner's example as data:

| Line         | Kind          | Stage               | Quantity per bottle |
| ------------ | ------------- | ------------------- | ------------------- |
| Glass bottle | `NEW_BOTTLE`  | `LABEL_APPLICATION` | 1 pcs (always 1)    |
| Label        | `LABEL_MEDIA` | `LABEL_APPLICATION` | 1 pcs               |
| Liquid       | `BULK_LIQUID` | `FILL`              | 330 ml              |
| Pump         | `PUMP`        | `FILL`              | 1 pcs               |
| Crate type   | —             | —                   | capacity 40         |

## 4. Versioning rules

- A product may have many versions; each **starts as a `DRAFT`** (with content, empty, or as a
  copy of an existing version — "new version").
- A draft may be **incomplete** but never **invalid**: every write is validated (below). Editing a
  draft appends a revision; earlier revisions and their BOMs stay in the database.
- **Activation** needs a complete, valid draft (today's catalogue: no archived item) and the
  version the client expects to be active (`expectedActiveVersion`, `null` = none). If another
  version is active and expected, it is **archived in the same transaction** — at no moment are
  two versions active; a stale expectation is refused (`409 ACTIVE_VERSION_CHANGED`).
- **At most one `ACTIVE` version per product** (partial unique index).
- An `ACTIVE` or `ARCHIVED` version **never changes** — no revision, no line, no status back; a
  change is a new version (`409 RECIPE_NOT_DRAFT`). "Used" versions are a subset of these: only
  an active version will ever be referenced by later phases.
- **Archiving** (a draft or the active version) only moves the status forward: every revision,
  BOM, line and reference stays readable, and the material calculation still works for history.
- Status is forward-only: `DRAFT → ACTIVE → ARCHIVED` or `DRAFT → ARCHIVED`.

**Validation of a line** (API; the database repeats every rule except "known item" and the error
codes): known item of a recipe kind (`COMPONENT_NOT_ALLOWED` for packaging and others), not
archived (`ITEM_ARCHIVED`), each item and each kind once (`DUPLICATE_COMPONENT`,
`DUPLICATE_COMPONENT_KIND`), unit = the item's base unit (`UNIT_MISMATCH` — no implicit conversion)
and allowed for the kind (liquid: a volume unit; the others: `pcs`), quantity > 0 in the unit's
scale (pieces whole), bottle body exactly 1 (`BOTTLE_BODY_QUANTITY`) and **lot-tracked**
(`LOT_TRACKING_REQUIRED` — label application consumes it from the lot the operator selects,
doc 018), liquid and label made for the product's category, any other component that names a
category names the product's (`COMPONENT_CATEGORY_MISMATCH`), crate type carrying the product's
category (`CRATE_TYPE_CATEGORY_MISMATCH`). A new bottle-body component must be lot-tracked too.

## 5. Material calculation

A pure function (`apps/api/src/catalog/material-requirements.ts`) and
`GET …/recipes/:version/requirements?bottles=N` (N = 1…1 000 000, an input guard): each line's
per-bottle quantity × N as an exact decimal, and the crates by the crate type's capacity
**rounded up** — never down:

| Bottles   | Glass bottles | Liquid         | Pumps     | Labels    | Crates (full + partial)   |
| --------- | ------------- | -------------- | --------- | --------- | ------------------------- |
| 1         | 1             | 330 ml         | 1         | 1         | 1 (0 full, 1 bottle)      |
| 40        | 40            | 13 200 ml      | 40        | 40        | **1** (1 full)            |
| 41        | 41            | 13 530 ml      | 41        | 41        | **2** (1 full + 1 bottle) |
| 1 000 000 | 1 000 000     | 330 000 000 ml | 1 000 000 | 1 000 000 | 25 000 (all full)         |

`crates = { count = ⌈N / capacity⌉, full = ⌊N / capacity⌋, partialCrateBottles = N mod capacity }`.
A non-multiple of the capacity is therefore explicit: the last crate is reported as partial (ADR
0021: a partial crate is never made ready manually — the calculation does not decide what happens
to it). A total that would not fit an exact quantity is refused (`422 QUANTITY_TOO_LARGE`), never
rounded. An incomplete version answers `422 RECIPE_INCOMPLETE`. The calculation reads only the
catalogue — it reserves, consumes and reads no stock.

## 6. Database invariants

| Rule                                                                                                        | Enforcement                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| categories, components, crate types, products immutable                                                     | `ayvo_reject_modification` triggers (UPDATE/DELETE/TRUNCATE)                                |
| liquid/label name a category; capacity only for packaging                                                   | `catalog_components_check`; capacity CHECK 1–100 000                                        |
| crate capacity is data, 1–1000; ≥ 1 category                                                                | CHECK; commit-time `crate_types_has_category`                                               |
| product code, name, nominal quantity > 0 in unit scale                                                      | CHECKs; `products_scale`                                                                    |
| at most one active version per product                                                                      | partial unique `recipe_versions_one_active`                                                 |
| a version starts as DRAFT, always with revision 1                                                           | `recipe_versions_insert`; commit-time `recipe_versions_has_revision`                        |
| forward-only status, identity immutable, never deleted                                                      | `recipe_versions_guard`; status/actor CHECK                                                 |
| activation only when complete (crate type + 4 kinds, no archived item)                                      | `ayvo_assert_recipe_complete` in `recipe_versions_guard`                                    |
| revisions consecutive, only while DRAFT                                                                     | `recipe_revisions_append` (locks the version row); insert-only                              |
| stage, kind, unit, bottle = 1 and lot-tracked, category, no archived item, one line per kind                | `recipe_revision_boms_check`; insert-only                                                   |
| a revision links only its own BOM (`R-<PRODUCT>-V<n>-LA/FL`, version = revision), never a global stage rule | `recipe_revision_boms_check`                                                                |
| only activation records an activation                                                                       | `recipe_versions_guard`                                                                     |
| a linked recipe BOM is sealed                                                                               | `bom_lines_recipe_sealed` (new trigger; legacy rules unaffected); lines immutable (doc 018) |
| category copy = product's; crate type carries it                                                            | composite FKs `(product_id, category_code)`, `(crate_type_id, category_code)`               |
| recipe BOMs never act as the global stage rule                                                              | `InventoryService.activeBom` excludes BOMs linked to a recipe (test)                        |

## 7. API contracts (`@ayvo/types`, `catalog.ts`)

Every change: `requestId` (UUID, idempotent — same payload replays the stored result, another
payload → `409 IDEMPOTENCY_CONFLICT`) and `reason` (3–500 characters, audited). Errors carry a
stable `code`; database messages never reach the client.

| Method | Route (`/api/admin/catalog/…`)                           | Permission                 | Body / result                                                                                                     |
| ------ | -------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `categories`                                             | `catalog:read`             | `ProductCategory[]`                                                                                               |
| GET    | `components`                                             | `catalog:read`             | `CatalogComponent[]` (items of component kinds + profile)                                                         |
| POST   | `components`                                             | `catalog:manage`           | `{requestId, code, name, kind, unitCode, lotTracked, categoryCode, packageCapacity, reason}` → 201                |
| GET    | `crate-types`                                            | `catalog:read`             | `CrateType[]`                                                                                                     |
| POST   | `crate-types`                                            | `catalog:manage`           | `{requestId, code, name, capacity, categoryCodes, reason}` → 201                                                  |
| GET    | `products`, `products/:code`                             | `catalog:read`             | `Product` (with version summaries and `activeVersion`)                                                            |
| POST   | `products`                                               | `catalog:manage`           | `{requestId, code, name, categoryCode, nominalQuantity, nominalUnitCode, reason}` → 201                           |
| POST   | `products/:code/recipes`                                 | `catalog:manage`           | `{requestId, reason, crateTypeCode, components[]}` or `{requestId, reason, basedOnVersion}` → 201 `RecipeVersion` |
| GET    | `products/:code/recipes/:version`                        | `catalog:read`             | `RecipeVersion` (current revision, `missing`)                                                                     |
| PUT    | `products/:code/recipes/:version`                        | `catalog:manage`           | `{requestId, reason, crateTypeCode, components[]}` — DRAFT only, appends a revision (`422 NO_CHANGES`)            |
| POST   | `products/:code/recipes/:version/activate`               | `catalog:recipes_activate` | `{requestId, reason, expectedActiveVersion}` → 200                                                                |
| POST   | `products/:code/recipes/:version/archive`                | `catalog:recipes_activate` | `{requestId, reason}` → 200                                                                                       |
| GET    | `products/:code/recipes/:version/requirements?bottles=N` | `catalog:read`             | `MaterialRequirements`                                                                                            |

A component line is `{itemCode, quantity, unitCode}`: the quantity per ONE finished bottle in the
item's base unit.

**Permissions** (migration, granted explicitly): `catalog:read` — ADMIN, PRODUCTION_OPERATOR,
PRODUCTION_SUPERVISOR, WAREHOUSE_SUPERVISOR; `catalog:manage` and `catalog:recipes_activate` —
ADMIN only (a custom role may hold them; drafting and activation are separate). All three are
global (no site, no warehouse). Audit events: `CATALOG_COMPONENT_CREATED`, `CRATE_TYPE_CREATED`,
`PRODUCT_CREATED`, `RECIPE_DRAFT_CREATED`, `RECIPE_DRAFT_UPDATED` (before/after),
`RECIPE_ACTIVATED` (replaced version), `RECIPE_ARCHIVED` (previous status, replaced by).

**Concurrency.** Lock order: operation request → product row → recipe version row(s). All
version changes of one product are serialised; two concurrent activations → one `200`, one
`409 ACTIVE_VERSION_CHANGED`. A refused operation leaves nothing (one transaction, including the
request row), so the same `requestId` succeeds once the cause is fixed.

**Limits of the database checks (by design or deferred):** the ledger trigger of label application
(doc 018) accepts any complete `LABEL_APPLICATION` BOM — today only `activeBom`, which excludes
recipe BOMs, stands between the standalone label application and recipe BOMs; the production-scan
phase must bind consumption to the order's recipe (doc 020 condition 4). Sealing a recipe BOM is
checked when a line is inserted; a line inserted concurrently into a BOM whose link is not yet
committed is not caught (the application never does this). An idempotent replay is not bound to
the user who sent it (the shared `OperationRequestsService` pattern).

**Module boundaries:** the catalog module reads items, units and BOM lines only through
`InventoryService` and crate types through `CrateTypesService`; it writes only its own tables
(items and BOMs are created through `InventoryService`).

## 8. Boundaries of this phase

**In:** the database and API above, the migrations
`20261013090000_catalog_enum_values` (`ConsumptionStage.FILL`, operation kinds) and
`20261013090100_product_catalog_and_recipes` (tables, triggers, two category rows, three
permissions and their grants) — additive only, no existing row changed. The only existing objects
touched are a new trigger on `bom_lines` (recipe BOMs only) and the `activeBom` query (excludes
recipe BOMs).

**Not in:** administration UI; receipts or issues; reservation or automatic consumption of stock;
any change to the ledger, balances or the label-application path; product-label approvals; crates,
crate QR identities, crate labels and cycles; product archiving; item archiving/editing; monthly
inventory and liquid weighing; billing, hotel portal, commissions; any DEV data.

## 9. Next phase — administration UI (proposal)

Under **Výroba → Produkty a receptury** (doc 020 §14 step 7, doc 019 — no new top-level entity
navigation):

1. **Katalog komponent** — list (kind, unit, category, packaging capacity "neznámá"), "Nová
   komponenta" form with the kind/unit rules in Czech.
2. **Produkty** — list with the active version; product detail with the version history
   (draft/aktivní/archivovaná, revision, based on, who and when).
3. **Kusovník (verze)** — draft editor: four fixed rows (lahev, etiketa, kapalina, pumpička) with
   item pickers filtered by kind and category, crate type, Czech validation messages, a summary
   "Co se uloží" and a mandatory reason (the pattern of the access editor, doc 021 §7);
   "Nová verze" (copy), "Aktivovat" (shows the version it will replace) and "Archivovat".
4. **Výpočet materiálu** — number of bottles → table of components and crates (full + partial).
5. Playwright: four widths, keyboard, no horizontal overflow; permissions hide nothing the server
   would allow.

## 10. Later phases (not designed here beyond doc 020)

- **Production order** (doc 020 §3.7): snapshots the product's ACTIVE recipe version (FK to
  `recipe_versions`); the activation BOM read **through the recipe**, never `activeBom`.
- **Reservations** of the order's material (doc 020 §5) from the requirement calculation, per
  site warehouse.
- **Real consumption**: `LABEL_APPLICATION` stage at the production scan, `FILL` stage at filling
  (2B), each as ledger movements bound to their BOM lines.
- **Waste and corrections** — compensating movements with reasons (doc 018 §16).
- **Stocktaking** (counted vs. ledger, adjustment movements) and **monthly liquid weighing**
  (measured variance as its own movement; weighing gives grams — the volume ↔ mass conversion needs
  a documented density per liquid, never an implicit conversion).

## 11. Known limitations and open questions

- **Which label is "correct"** is checked by the label item's category. Which _label design_ a
  product prints (`product_label_approvals`, doc 020 §3.3) is not implemented yet.
- **Label media in the recipe** sit in the `LABEL_APPLICATION` stage. **Open owner question:**
  is label stock consumed when printing or when applying, and is it lot-tracked? Today's
  activation core consumes exactly one lot-tracked line from the operator's selected lot; a
  recipe whose label item is lot-tracked would have two such lines, so the production-scan phase
  must settle this (doc 020 condition 3) before it consumes recipe BOMs.
- **Owner decisions this PR proposes** (not yet confirmed): (1) catalogue changes are ADMIN-only by
  default (doc 020 §12 gave them to `PRODUCTION_SUPERVISOR`; see §7); (2) the table design of §3 —
  append-only revisions instead of mutable `recipe_version_stages`, the `catalog_components`
  profile, no product status, crate types created through the API instead of seeded.
- **Shipping box**: a catalogue component only; it is not part of the bottle recipe or the
  calculation. When and per how many bottles it is used is an open question (ADR 0021: deliveries
  are whole returnable crates).
- **No product or item archiving** and no editing of names; a correction is a new code. Item
  archiving exists in the schema (doc 018) but has no API; activation refuses archived items.
- `package_capacity` cannot be set later yet (immutable profile); recording it once known needs a
  small follow-up (append-only).
- The product's nominal quantity and the recipe's liquid quantity are not compared (overfill is a
  2B question, doc 020 §3.3).
- Crate types cannot be archived yet.

## 12. Tests

- `apps/api/src/catalog/material-requirements.test.ts` — exact totals for 1, 40, 41, 79–81,
  999 999 and 1 000 000 bottles, fractional quantities, capacity as data (24), crate rounding up,
  invalid input, overflow refused.
- `apps/api/test/catalog.e2e.test.ts` (real guard, sessions, database) — components (incl. the
  unknown box capacity), crate types and products; validation with stable codes and no database
  text; draft → active → new version → swap → archive with audit and reasons; archived drafts;
  concurrent activation (exactly one wins); concurrent drafts (consecutive versions) and concurrent codes (`CODE_TAKEN` once); lot-tracked bottle body (API and database); a foreign or global BOM refused by the database; duplicates, wrong units, zero/negative/fractional
  quantities, incompatible components and crates; an item archived after drafting; the calculation
  through the API; authorization (401, 403 for warehouse operators, read-only production roles, a
  custom role that drafts but cannot activate) and mandatory reasons; idempotent replay, conflict,
  concurrent duplicates and retry after refusal; zero impact of refused operations; every
  database invariant of §6 without the application; the global label-application rule unchanged;
  stock (movements, balances, lots, locations, receipts) byte-for-byte unchanged and no drift.
- `apps/api/test/identity.e2e.test.ts` — the role matrix includes the catalogue permissions;
  `migrations.e2e.test.ts` — no drift, clean and stepwise apply.
