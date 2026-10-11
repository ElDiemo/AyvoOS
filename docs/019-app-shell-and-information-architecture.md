# 019 — Application shell and information architecture (Milestone 2A.1)

Status: Implemented on branch `feat/app-shell-information-architecture` (DEV preview only) —
direction given by the owner on 2026-10-11. Architecture decision: [ADR 0020](adr/0020-operational-modules-and-application-shell.md).

## 1. Why

Milestones 1 and 2A exposed **Bottles**, **Label templates** and **Sklad** as peer top-level
items and placed physical label application inside the warehouse. That followed database entities
and implementation order, not how AYVO works. AYVO OS is organized by **company functions**.

## 2. Operational modules (binding)

| Module                  | Owns                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sklad** (Warehouse)   | Physical inventory: warehouse overview, current stock, incoming goods, receipts, supplier and internal lots, stock movements, suppliers. Later: inventory counts, stock thresholds.                                                                                                       |
| **Výroba** (Production) | Transformation and production work: production overview, bottle identities and lifecycle, creation of bottle/label series, label print jobs, label templates, physical label application and its verification scan. Later: component assembly, crates, filling, rework, production scrap. |

- **Label application belongs to Production**, not to the warehouse. It consumes warehouse stock
  (one new bottle from the selected lot) through the inventory ledger; the warehouse sees the
  movement, but the work is production work.
- **Bottles and label templates are Production capabilities**, not top-level company modules.
- Future modules (hotels, sales, finance, ESG, quality, returns, logistics) appear in the
  navigation **only when implemented and permitted by the user's roles** — never as dead or
  disabled items.
- The **hotel portal will be a separate customer environment** (its own shell and navigation for
  hotel users, read-only for their own hotel, ADR 0017), not a module of this internal shell.

## 3. Shell

- Desktop (≥ 1024 px): persistent left navigation — AYVO OS brand, DEV badge, **Přehled**, then
  the section **Provoz** with **Sklad** and **Výroba** only. A compact top bar shows the location
  (module / page) and the environment. Content is limited to 80 rem width.
- Phones and tablets: the navigation is a drawer (native `<dialog>`: focus trap, Escape, backdrop
  click) opened from the top bar; the top bar stays 56 px high so scanner screens keep the space.
- Each module has its own **contextual navigation** (tabs, one URL per page): wraps on wide screens
  (never a scrollbar), scrolls sideways without a visible scrollbar on phones.
  - Sklad: Přehled skladu · Příjem zboží · Příjmy · Stav skladu · Pohyby · Dodavatelé.
  - Výroba: Přehled výroby · Lahve · Šablony etiket · Nalepení etiket.
- Environment badge from `APP_ENV` of the web server: `DEV` / `TEST`; production shows none; an
  unset value counts as development so a misconfigured server never looks like production.
- No user name, role or login state is shown: application accounts do not exist (ADR 0017).
- Czech copy throughout the internal application (`apps/web/src/i18n/cs/{shell,warehouse,production}.ts`).
  Codes (`AYV-B-…`, `BC-…`, `PJ-…`, `GR-…`), template names and API messages behind
  "Akce se nezdařila: …" stay language-neutral. The **public bottle passport** (`/q/<token>`) is
  customer-facing and stays English until the owner decides its language.

## 4. Routes

| URL                                                                                                                         | Module / page                  | Notes                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `/`                                                                                                                         | Přehled                        | Real figures of the implemented modules, warnings, actions, system status. |
| `/warehouse`                                                                                                                | Sklad / Přehled skladu         | Was a redirect to label application; now the warehouse overview.           |
| `/warehouse/receipts/new`, `/warehouse/receipts[/GR-…]`, `/warehouse/stock`, `/warehouse/movements`, `/warehouse/suppliers` | Sklad                          | unchanged                                                                  |
| `/production`                                                                                                               | Výroba / Přehled výroby        | New.                                                                       |
| `/production/label-activation`                                                                                              | Výroba / Nalepení etiket       | Canonical label-application station.                                       |
| `/warehouse/labels`                                                                                                         | —                              | **HTTP 307** to `/production/label-activation`, query string kept.         |
| `/bottles…`, `/batches/BC-…`, `/label-templates…`                                                                           | Výroba / Lahve, Šablony etiket | URLs kept for compatibility (links, bookmarks); shown inside Production.   |

The navigation model is one table (`apps/web/src/lib/navigation.ts`): modules, their pages and the
URL prefixes each page owns; breadcrumbs and active states derive from it.

## 5. Permission-filtered navigation (later)

`visibleModules()` returns every implemented module today. When authentication and RBAC exist
(ADR 0017), it becomes a server-side filter by the user's permissions and the API enforces the same
permissions. Hiding a link is never the security boundary. Planned permission names for the
production pages: `production.bottles.manage`, `production.labels.print`,
`production.templates.manage`, `production.label.apply` (replaces the provisional
`warehouse.label.apply` of doc 018 §11).

## 6. Overviews (read-only, real data only)

- **Přehled**: Sklad — new bottles on hand, receipts awaiting an invoice, active suppliers, warnings
  (no supplier, no stock, below reorder point, invoices pending); Výroba — bottle identities,
  awaiting a label (`CREATED`), labelled (`LABELED_EMPTY`); system status. A module whose figures
  cannot be loaded shows a notice; the page still renders.
- **Přehled skladu**: stock per item with lots, what needs attention, last receipts, last
  movements, next useful action (create supplier → first receipt → receive goods).
- **Přehled výroby**: counts, last series with their print state, last label applications, links to
  the production capabilities. Crates and filling are not shown (not implemented).

The only API addition is an optional `status` filter on `GET /api/admin/bottles` (read-only, no
migration) for the "awaiting label" / "labelled" counts and the bottle list filter.

## 7. Label application: series binding (server-enforced)

The station now asks for two session choices, both kept per browser tab and changed only by an
explicit action: the **bottle series** being labelled (`BC-…`, only series with a completed print
job are offered) and the **source stock lot**. Every scan sends `seriesCode`; the server refuses a
bottle of any other series with `422 WRONG_SERIES` before anything is locked or consumed. A
bottle's series is immutable, so the check needs no lock and no migration. `seriesCode` is part of
the idempotent payload: a retry with the same request id and the same series replays; the same
request id with another series is `IDEMPOTENCY_CONFLICT`; rejections are never stored.

Check order: `NOT_AYVO_QR` / `WRONG_ENVIRONMENT` → `WRONG_LOT` → `UNKNOWN_LABEL` → `WRONG_SERIES`
→ `LABEL_NOT_PRINTED` → bottle lock → `ALREADY_APPLIED` / `NOT_APPLICABLE` → `LOT_EXHAUSTED`.

What this does **not** do (first follow-up of the production workflow): it binds the session to a
**series**, not to a **product** or a **production order**. Products do not exist yet (Milestone
2B), and a series is chosen by the operator, not assigned by a planner. Binding label work to a
product, a production order or a specific print job (reprints share bottles) needs a
production-order/session model and a migration — not built here.

## 8. Not changed

No database schema change or migration; no change of inventory ledger invariants or Milestone 2A
transactions apart from the additional `WRONG_SERIES` rejection; no authentication or roles; no
crates, filling, hotels, sales, billing, PPL or returns.

## 9. Follow-ups

1. **Production orders / sessions** with product binding (see section 7) — first production
   workflow follow-up.
2. Permission-filtered navigation and API guards once ADR 0017 is resolved.
3. Language of the public passport and of API error details (currently English).
4. Recent label applications are global (last 20), not per station or operator — needs accounts.
