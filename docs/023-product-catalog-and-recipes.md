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

| Table                   | Purpose and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_categories`    | `HAND_SOAP` "Tekuté mýdlo", `SHOWER_GEL` "Sprchový gel" — confirmed reference data (doc 020), seeded; a table, so a third category needs no enum migration. Immutable.                                                                                                                                                                                                                                                                                                                                                                         |
| `inventory_items`       | (existing, doc 018) the component itself: code, name, kind, base unit, lot tracking. New items are created by the catalogue — never a receipt (no lot, movement or balance).                                                                                                                                                                                                                                                                                                                                                                   |
| `catalog_components`    | the catalogue profile of an item (1:1): `category_code` (the category it is made for; **required** for liquids and labels, `NULL` = any category), `package_capacity` (packaging only; `NULL` = unknown). Immutable.                                                                                                                                                                                                                                                                                                                           |
| `crate_types`           | returnable crate type: code, name, **capacity** (1–1000, data — never a constant), immutable (crates module, doc 020 §3.4).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `crate_type_categories` | the categories a crate type carries (at least one, checked at commit). Insert-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `products`              | code (`^[A-Z0-9][A-Z0-9_-]{1,23}$`), name, category, nominal quantity + unit (e.g. 330 ml — product data, separate from the recipe's liquid line), status `ACTIVE`/`ARCHIVED` (doc 020 §3.3). Code, category, nominal quantity and creation are immutable; the **name may be corrected** while ACTIVE (`PRODUCT_RENAMED`, before/after, reason); **archiving** is forward-only, refused while a recipe version is ACTIVE, and blocks every new or changed recipe version (`409 PRODUCT_ARCHIVED`) — all versions stay readable and calculable. |
| `recipe_versions`       | per product: `version` 1–9999, `status` `DRAFT`/`ACTIVE`/`ARCHIVED`, `based_on_id` (copied from, same product), created/activated/archived by and at. A copy of the product's category (composite FK) lets the database check components and crates.                                                                                                                                                                                                                                                                                           |
| `recipe_revisions`      | the content of a version at one revision: crate type (nullable in a draft) + its stage BOMs. **Insert-only**; a draft edit appends the next revision; the highest one is current and is frozen by activation.                                                                                                                                                                                                                                                                                                                                  |
| `recipe_revision_boms`  | per revision and stage one recipe-owned `bom_versions` row (code `R-<PRODUCT>-V<n>-LA`/`-FL`, version = revision). A BOM belongs to at most one revision, ever.                                                                                                                                                                                                                                                                                                                                                                                |

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
A non-multiple of the capacity is therefore explicit: the last crate is reported as partial. These
are **planning figures only**: 2 crates for 41 bottles is the capacity to plan, **not** permission
to prepare, fill or ship a partial crate (ADR 0021: a partial cycle is never made ready manually;
v0.1 deliveries are whole crates of 40). The returnable crate is a planned **resource**, not a
consumable component: it is never written off per 40 bottles and is not a BOM line. A total that would not fit an exact quantity is refused (`422 QUANTITY_TOO_LARGE`), never
rounded. An incomplete version answers `422 RECIPE_INCOMPLETE`. The calculation reads only the
catalogue — it reserves, consumes and reads no stock.

## 6. Database invariants

| Rule                                                                                                                                                                                                                                                                 | Enforcement                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| categories, components, crate types immutable; product identity immutable, name only while ACTIVE, status forward-only, archive only without an ACTIVE recipe                                                                                                        | `ayvo_reject_modification`; `products_guard`                                                    |
| archived product: no new version, revision or activation                                                                                                                                                                                                             | `recipe_versions_insert`, `recipe_revisions_append`, `recipe_versions_guard` (product row lock) |
| liquid/label name a category; capacity only for packaging                                                                                                                                                                                                            | `catalog_components_check`; capacity CHECK 1–100 000                                            |
| crate capacity is data, 1–1000; ≥ 1 category                                                                                                                                                                                                                         | CHECK; commit-time `crate_types_has_category`                                                   |
| product code, name, nominal quantity > 0 in unit scale                                                                                                                                                                                                               | CHECKs; `products_scale`                                                                        |
| at most one active version per product                                                                                                                                                                                                                               | partial unique `recipe_versions_one_active`                                                     |
| a version starts as DRAFT, always with revision 1                                                                                                                                                                                                                    | `recipe_versions_insert`; commit-time `recipe_versions_has_revision`                            |
| forward-only status, identity immutable, never deleted                                                                                                                                                                                                               | `recipe_versions_guard`; status/actor CHECK                                                     |
| activation only when complete (crate type + 4 kinds, no archived item)                                                                                                                                                                                               | `ayvo_assert_recipe_complete` in `recipe_versions_guard`                                        |
| revisions consecutive, only while DRAFT                                                                                                                                                                                                                              | `recipe_revisions_append` (locks the version row); insert-only                                  |
| stage, kind, unit, bottle = 1 and lot-tracked, category, no archived item, one line per kind                                                                                                                                                                         | `recipe_revision_boms_check`; insert-only                                                       |
| a revision links only its own BOM (`R-<PRODUCT>-V<n>-LA/FL`, version = revision), never a global stage rule                                                                                                                                                          | `recipe_revision_boms_check`                                                                    |
| only activation records an activation                                                                                                                                                                                                                                | `recipe_versions_guard`                                                                         |
| a linked recipe BOM is sealed — **serialised**: the link locks the BOM row `FOR UPDATE`, a new line locks it `FOR SHARE` first, so a concurrent line is either committed before the link (and validated by it) or sees the link and is refused (two-connection test) | `bom_lines_recipe_sealed` (new trigger; legacy rules unaffected); lines immutable (doc 018)     |
| category copy = product's; crate type carries it                                                                                                                                                                                                                     | composite FKs `(product_id, category_code)`, `(crate_type_id, category_code)`                   |
| recipe BOMs never act as the global stage rule                                                                                                                                                                                                                       | `InventoryService.activeBom` excludes BOMs linked to a recipe (test)                            |

## 7. API contracts (`@ayvo/types`, `catalog.ts`)

Every change: `requestId` (UUID, idempotent — same payload replays the stored result, another
payload → `409 IDEMPOTENCY_CONFLICT`) and `reason` (3–500 characters, audited). Errors carry a
stable `code`; database messages never reach the client.

| Method | Route (`/api/admin/catalog/…`)                           | Permission               | Body / result                                                                                                     |
| ------ | -------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `categories`                                             | `catalog:read`           | `ProductCategory[]`                                                                                               |
| GET    | `units`                                                  | `catalog:read`           | `CatalogUnit[]` (reference units: code, name, decimals, dimension — for the catalogue forms)                      |
| GET    | `components`                                             | `catalog:read`           | `CatalogComponent[]` (items of component kinds + profile)                                                         |
| POST   | `components`                                             | `catalog:product_manage` | `{requestId, code, name, kind, unitCode, lotTracked, categoryCode, packageCapacity, reason}` → 201                |
| GET    | `crate-types`                                            | `catalog:read`           | `CrateType[]`                                                                                                     |
| POST   | `crate-types`                                            | `catalog:product_manage` | `{requestId, code, name, capacity, categoryCodes, reason}` → 201                                                  |
| GET    | `products`, `products/:code`                             | `catalog:read`           | `Product` (with version summaries and `activeVersion`)                                                            |
| POST   | `products/:code/rename`                                  | `catalog:product_manage` | `{requestId, name, reason}` → 200 (ACTIVE only; `422 NO_CHANGES`)                                                 |
| POST   | `products/:code/archive`                                 | `catalog:product_manage` | `{requestId, reason}` → 200 (`409 PRODUCT_HAS_ACTIVE_RECIPE`)                                                     |
| POST   | `products`                                               | `catalog:product_manage` | `{requestId, code, name, categoryCode, nominalQuantity, nominalUnitCode, reason}` → 201                           |
| POST   | `products/:code/recipes`                                 | `catalog:product_manage` | `{requestId, reason, crateTypeCode, components[]}` or `{requestId, reason, basedOnVersion}` → 201 `RecipeVersion` |
| GET    | `products/:code/recipes/:version`                        | `catalog:read`           | `RecipeVersion` (current revision, `missing`)                                                                     |
| PUT    | `products/:code/recipes/:version`                        | `catalog:product_manage` | `{requestId, reason, crateTypeCode, components[]}` — DRAFT only, appends a revision (`422 NO_CHANGES`)            |
| POST   | `products/:code/recipes/:version/activate`               | `catalog:recipe_approve` | `{requestId, reason, expectedActiveVersion}` → 200                                                                |
| POST   | `products/:code/recipes/:version/archive`                | `catalog:recipe_approve` | `{requestId, reason}` → 200                                                                                       |
| GET    | `products/:code/recipes/:version/requirements?bottles=N` | `catalog:read`           | `MaterialRequirements`                                                                                            |

A component line is `{itemCode, quantity, unitCode}`: the quantity per ONE finished bottle in the
item's base unit.

**Permissions** (doc 020 §12 as approved; migration, granted explicitly; all global — no site,
no warehouse):

| Permission                                 | Covers                                                                     | Approved doc 020 §12                       | This PR                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `catalog:read`                             | catalogue, recipes, material calculation                                   | — (not listed)                             | **new**: ADMIN, PRODUCTION_OPERATOR, PRODUCTION_SUPERVISOR, WAREHOUSE_SUPERVISOR                                    |
| `catalog:product_manage`                   | components, crate types, products (create, rename, archive), recipe drafts | PRODUCTION_SUPERVISOR ✓, ADMIN "emergency" | PRODUCTION_SUPERVISOR ✓, ADMIN ✓ (doc 021: ADMIN holds every permission; no separate emergency override exists yet) |
| `catalog:recipe_approve`                   | activate and archive recipe versions                                       | PRODUCTION_SUPERVISOR ✓, ADMIN "emergency" | PRODUCTION_SUPERVISOR ✓, ADMIN ✓                                                                                    |
| label approvals (`catalog:product_manage`) | product-label approvals                                                    | PRODUCTION_SUPERVISOR                      | not implemented (§11)                                                                                               |

The first draft of this PR made changes ADMIN-only; that was an unapproved deviation and was
replaced by the approved matrix before merge (the migration had not run in any shared environment,
so it was corrected in place). **Open owner question:** since 2026-10-12 a site-bound
`PRODUCTION_SUPERVISOR` no longer changes company-wide label templates (doc 021 §4); should the
same apply to the company-wide catalogue? If yes, a later migration revokes the two supervisor
grants.

Audit events: `CATALOG_COMPONENT_CREATED`, `CRATE_TYPE_CREATED`, `PRODUCT_CREATED`,
`PRODUCT_RENAMED` (before/after), `PRODUCT_ARCHIVED`, `RECIPE_DRAFT_CREATED`,
`RECIPE_DRAFT_UPDATED` (before/after), `RECIPE_ACTIVATED` (replaced version), `RECIPE_ARCHIVED`
(previous status, replaced by).

**Concurrency.** Lock order: operation request → product row → recipe version row(s). All
version changes of one product are serialised; two concurrent activations → one `200`, one
`409 ACTIVE_VERSION_CHANGED`. A refused operation leaves nothing (one transaction, including the
request row), so the same `requestId` succeeds once the cause is fixed.

**Idempotency is bound to the author.** Every catalogue operation hashes the actor with the
payload: the same user replays the stored result; another user (even with the same permission)
gets `409 IDEMPOTENCY_CONFLICT`, never someone else's result (test). The route permission is checked
before any replay, so a caller without it gets `403`.

**Ledger and recipe BOMs (doc 018 behaviour, unchanged here).** The ledger trigger of label
application accepts a movement for any line of a complete `LABEL_APPLICATION` BOM. Reachable paths
that write such movements: exactly one — `POST /api/admin/label-applications`
(`production:label_apply`, active site + warehouse), which reads the BOM through
`InventoryService.activeBom`. Before this PR there were no recipe BOMs; with this PR `activeBom`
excludes every BOM linked to a recipe, and a test performs a real label application next to an
active recipe whose `LABEL_APPLICATION` BOM holds the bottle and a label: exactly one movement,
on the global rule v1. Other writers would need direct database access. Binding the ledger itself
to recipes is a ledger change and belongs to the production-scan phase (doc 020 condition 4); it
is deliberately not done here.

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
crate QR identities, crate labels and cycles; item archiving/editing; monthly
inventory and liquid weighing; billing, hotel portal, commissions; any DEV data.

## 9. Administration UI (implemented, issue #17)

**Výroba → Produkty a receptury** (`/production/catalog`, doc 019 — no new top-level module), with
three views — **Produkty**, **Komponenty**, **Typy beden** — and the permanent note: _Katalog platí
pro celou firmu. Zásoby patří jednotlivým provozovnám. Tyto změny nepřijímají ani nespotřebovávají
materiál._

| URL                                                   | Needs                             | Content                                                                                                           |
| ----------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/production/catalog`                                 | `catalog:read`                    | products: name, code, category, nominal content, active version                                                   |
| `/production/catalog/components` (`/new`)             | `catalog:read` (`product_manage`) | components: kind, unit, category, lot tracking, packaging capacity or "Neznámá"; form with the kind rules         |
| `/production/catalog/crate-types` (`/new`)            | `catalog:read` (`product_manage`) | crate types (definitions, not physical crates): capacity entered by the user, categories                          |
| `/production/catalog/products/new`                    | `catalog:product_manage`          | new product                                                                                                       |
| `/production/catalog/products/:code`                  | `catalog:read`                    | immutable identity, name correction, archiving (explained refusal with a link to the active version), versions    |
| `/production/catalog/products/:code/recipes/:version` | `catalog:read`                    | draft editor (manage) or read-only view; activate / archive (`recipe_approve`), new version, material calculation |

- **Navigation by permission:** Výroba is visible with `production:read` **or** `catalog:read`;
  every production page needs `production:read`, the catalogue `catalog:read` (page guards per
  section, not one guard for `/production`). A catalogue-only user sees just this page, needs no
  site, and is refused every operational page.
- **Editor:** four rows for one finished bottle (Lahev, Etiketa, Kapalina, Pumpička) with the
  planned stage of each, items filtered by kind, category and archive, the unit taken from the
  item, the bottle body fixed at 1, the crate type filtered by category; "Co se uloží", mandatory
  reason, "Neuložené změny" with the shared leave guard (doc 021 §7); activation only for a
  saved, complete draft, with a confirmation naming the version it replaces and
  `expectedActiveVersion` from the page; `ACTIVE_VERSION_CHANGED` is explained with "Načíst
  aktuální stav" (never retried with a new expectation).
- **Exactness:** Czech decimal input is converted to exact decimal strings (refused, never
  rounded); totals come from the API and are only formatted.
- **Idempotency in the browser:** one attempt keeps its request id while the request is unchanged
  and the answer was not definite (network error, double click); a definite answer or changed data
  starts a new attempt.
- **Units:** `GET /api/admin/catalog/units` (`catalog:read`) lists the reference units for the
  forms — no other inventory permission is needed.
- **Known limits:** no author per version in the UI (the API does not expose it; changes are in
  the audit); a draft update has no `expectedRevision` (two people editing one draft: the last
  save wins — said in the editor); new components also appear (with nothing on hand) in the stock
  overview and in receiving, because they are inventory items; on phones the module tabs scroll
  and the active one may be off-screen (issue #11, UI-08).

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
- **Deviations from the approved doc 020 §3.3**, separated:
  - _Recommended, no functionality lost:_ append-only `recipe_revisions` + `recipe_revision_boms`
    instead of a mutable `recipe_version_stages` (edit history kept, ADR 0006); the
    `catalog_components` profile (category designation, packaging capacity) instead of new
    columns on `inventory_items`.
  - _Now matching doc 020:_ product status `ACTIVE`/`ARCHIVED` with name correction (this PR).
  - _Open owner question:_ doc 020 §13 seeds two crate types of capacity 40; their codes and names
    are not defined, so this PR creates crate types through the API instead of inventing them.
- **The stage of the label line is not a decision about consumption.** Putting the label in
  `LABEL_APPLICATION` groups the recipe; whether label stock is consumed at printing or at
  application stays open (above).
- **Shipping box**: a catalogue component only; it is not part of the bottle recipe or the
  calculation. When and per how many bottles it is used is an open question (ADR 0021: deliveries
  are whole returnable crates).
- **Item archiving and item renaming** have no API yet (the column exists, doc 018); drafts and
  activation refuse archived items.
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
  concurrent activation (exactly one wins); product name correction and archiving (API and database); a replay by another user is a conflict; sealing vs. adding a line with two connections in both orders; concurrent drafts (consecutive versions) and concurrent codes (`CODE_TAKEN` once); lot-tracked bottle body (API and database); a foreign or global BOM refused by the database; duplicates, wrong units, zero/negative/fractional
  quantities, incompatible components and crates; an item archived after drafting; the calculation
  through the API; authorization (401, 403 for warehouse operators, a read-only production operator, a supervisor who drafts and activates, a
  custom role that drafts but cannot activate) and mandatory reasons; idempotent replay, conflict,
  concurrent duplicates and retry after refusal; zero impact of refused operations; every
  database invariant of §6 without the application; the global label-application rule unchanged;
  stock (movements, balances, lots, locations, receipts) byte-for-byte unchanged and no drift.
- `apps/api/test/label-application.e2e.test.ts` — a real label application next to an active
  recipe consumes exactly one bottle body by the global rule v1.
- `apps/api/test/identity.e2e.test.ts` — the role matrix includes the catalogue permissions;
  `migrations.e2e.test.ts` — no drift, clean and stepwise apply.
