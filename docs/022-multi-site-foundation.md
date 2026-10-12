# 022 — Multi-site foundation

Status: **Implemented on branch `feat/identity-access-core` (Milestone 2C)** — sites, site and
warehouse scopes, the active site and site administration. Decision:
[ADR 0023](adr/0023-sites-as-operational-boundary.md). Access model: [doc 021](021-identity-and-access.md).
Not implemented here: hotels, dispatch, carriers, production orders (their site rules are recorded
in §7–§8 for the milestones that build them).

## 1. Sites

A **site** is a physical AYVO facility — e.g. the Czech facility today, a German one later. It is
the top-level operational boundary. A site is **not** a country (a country may have several sites)
and **not** a legal entity (legal entities, VAT registrations and invoicing identities are modelled
with billing).

| Field                                    | Rules                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                                     | stable UUID — what other records reference                                                |
| `code`                                   | unique, `^[A-Z][A-Z0-9-]{1,19}$`, **immutable** (database)                                |
| `name`                                   | 1–120 characters                                                                          |
| `country_code`                           | ISO 3166-1 alpha-2                                                                        |
| `address_line1/2`, `postal_code`, `city` | complete for every site created in the UI; only the migrated initial site may start empty |
| `time_zone`                              | valid IANA zone (checked against PostgreSQL's zone list); timestamps are shown in it      |
| `default_locale`, `default_currency`     | `cs-CZ`-style locale, ISO 4217 currency                                                   |
| `capabilities`                           | any of `WAREHOUSE`, `PRODUCTION`, `RETURNS`                                               |
| `active`, `deactivated_at`               | consistent (CHECK); a site is **never deleted**                                           |
| `created_*`, `updated_*`                 | who and when; every change is also an audit event with a reason and the site              |

**Administration** (`/admin/sites`, permission `sites:manage`, ADMIN only): create, edit operational
details, set capabilities, deactivate and reactivate — each with a reason. Removing `WAREHOUSE`
from a site that has warehouses is refused. **Deactivation** is refused while it would break an
invariant; the detail page lists the blockers in advance: stock still on hand in the site's
warehouses (`STOCK_ON_HAND`) and the last active site (`LAST_ACTIVE_SITE`). Future modules add
theirs (active hotels served by the site, open production orders, crates in circulation, carrier
accounts). A deactivated site keeps all history readable; new operational writes are refused
(`409 SITE_INACTIVE`).

## 2. Warehouses belong to sites

Every inventory location (warehouse) belongs to exactly one site (`inventory_locations.site_id`,
immutable). v0.1: a site's operations act on its **default warehouse** (`is_site_default`, at most
one per site); warehouses are still created by migration. Goods receipts record their site; stock,
lots, movements, receipts, corrections and label application act on the warehouse of the request's
site only — another site's receipt is "not found".

Suppliers and supplier documents are company-wide (purchasing serves several sites); what they
were received into is per site.

## 3. Scopes: what vs. where

- **Roles** say what a user may do; **scopes** say where.
- `SITE` scope: the user may work at that site — at **all** its warehouses unless narrowed.
- `WAREHOUSE` scope: narrows a site to listed warehouses; it is valid **only** with an open scope of
  its site (database trigger), and a site scope is revoked only together with its warehouses.
- Non-ADMIN users need explicit site access; without it they see no warehouse data
  (`403 SITE_REQUIRED`).
- **ADMIN** has global access through the permission `sites:all_access` — explicit data,
  evaluated by the authorization service (`evaluateSites`), with no scope row per site.
- Every scope grant/revocation is an append-only audit event that records its site.

The user administration lets ADMIN choose 1. roles, 2. allowed sites, 3. optionally narrower
warehouses, and shows the **effective access** (what, and at which sites and warehouses) computed
by the server.

## 4. The active site

- `/api/auth/me` returns the user's sites (with their permitted warehouses), the session's active
  site and whether access is global.
- With one site (or one active site) it is selected automatically; with several, the shell shows a
  clear selector and `/select-site`; warehouse pages without a selection lead there.
- `POST /api/auth/active-site` stores the choice **on the server-side session** after checking it
  against the user's current sites; a forged choice is refused (`403 SITE_FORBIDDEN`) and audited.
- On every request the guard re-validates it; if access to the site was removed, the selection
  falls back (single remaining site) or is cleared — never trusted from the client.
- Any site id in a URL, query, body, cookie or header is ignored for authorization (tested).
- Switching reloads the page completely and clears browser-held station state, so nothing of the
  previous site stays on screen; server pages are rendered per request (`no-store`).
- Warehouse timestamps are shown in the active site's IANA time zone (stored in UTC).

## 5. Migration and preserved data

Migrations `20261012120000_site_scope_type` (enum value only; PostgreSQL needs it committed first),
`20261012120100_sites_and_custom_roles` and `20261012150000_site_owned_production_and_costs`
(series, bottles, print jobs and supplier documents → `SITE-1` by the same column-default
technique):

- create `sites` and **one deterministic initial site** — id `01990000-0000-7000-8000-000000000001`,
  code **`SITE-1`**, name "Výchozí provozovna", `CZ`, `Europe/Prague`, `cs-CZ`, `CZK`, capabilities
  `WAREHOUSE` + `PRODUCTION`, **address empty** ("Adresa není doplněná"). These are the values the
  application has used so far; ADMIN completes the address and may rename it after deployment
  (the code stays). No other facility is invented.
- assign every existing warehouse and goods receipt to `SITE-1` through **column defaults** (no
  UPDATE of immutable rows, no trigger bypass), then drop the defaults;
- create no stock movement, balance, receipt, lot or ledger event;
- give every user who already had a warehouse scope the matching site scope (audited as
  "Migration: site access derived from existing warehouse access").
- assume at most one pre-existing warehouse (true for every AYVO database: only `MAIN` was ever
  created); with more, the migration stops at the one-default-per-site index without changing
  anything (security review P3-6).

**Evidence (2026-10-12, local DEV PostgreSQL 18):**

| Check                                                  | Result                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean installation                                     | all 9 migrations applied to an empty database                                                                                                                                                                                                               |
| Schema drift (`prisma migrate diff`)                   | none (exit 0) — clean install and upgraded database                                                                                                                                                                                                         |
| Upgrade from `main` (`19baf97`)                        | a database filled by `main`'s own Playwright flows (2 suppliers, 3 documents, 2 receipts, 2 lots, 4 movements, 2 balances, 56 bottles, 58 bottle events, 4 series, 3 templates, 4 print jobs, 56 print items, 11 operation requests) upgraded without error |
| Existing-data preservation                             | all 27 pre-existing tables: identical row counts and identical content hashes (ignoring only the added `site_id` / `is_site_default`)                                                                                                                       |
| Site assignment                                        | `MAIN` → `SITE-1` (default warehouse); 2 of 2 receipts → `SITE-1`; movements still 4                                                                                                                                                                        |
| Production and purchasing ownership (`20261012150000`) | same database upgraded again: still 27 of 27 tables unchanged; 4 of 4 series, 56 of 56 bottles, 4 of 4 print jobs, 3 of 3 supplier documents → `SITE-1`; no price records created; no drift                                                                 |
| Scope upgrade (from this PR's previous head)           | a user with a `MAIN` warehouse scope gained the `SITE-1` site scope and one audit event                                                                                                                                                                     |

## 6. Future site ownership (rules for the next milestones)

| Entity (future)                      | Site rule                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| inventory locations, balances        | implemented: location → site; balances per location                               |
| goods receipts, stock movements      | implemented: receipt → site; movements per location                               |
| production orders, work sessions     | belong to the site that produces (doc 020)                                        |
| creation series, bottles, print jobs | implemented: the producing site (bottles and jobs via their series, composite FK) |
| label applications                   | implemented: the bottle's site = the consuming warehouse's site (trigger)         |
| supplier documents, receipt prices   | implemented: the receiving site                                                   |
| crates and crate cycles              | a crate's home site; a cycle belongs to the site that runs it (ADR 0021)          |
| returns, inspections, washing        | the receiving site (normally the hotel's fulfilment site)                         |
| dispatches and carrier requests      | the origin site, kept as a snapshot on the dispatch                               |

Human codes stay **globally unambiguous**: they come from global sequences in one database
(`GR-000123` exists once across all sites). If a site-aware prefix is introduced, it must be stable
(site codes are immutable). Timestamps are stored in UTC and presented in the site's time zone.

## 7. Hotels and their fulfilment site (decision, not implemented)

- A hotel's physical country/address and the AYVO site serving it are **separate**; the serving
  site is **never** derived from the hotel's country.
- v0.1: every hotel has exactly one active primary `fulfillment_site_id`; a hotel group may contain
  hotels served by different sites.
- Production planning, stock allocation, dispatch and crate circulation for a hotel order use the
  hotel's fulfilment site; an order stores an **immutable reference/snapshot** of the site chosen
  when it was created.
- Changing a hotel's fulfilment site affects **new orders only**; historical orders, shipments and
  crate cycles are never rewritten. Reassignment requires a reason and an immutable audit event.
- Returns normally route to the same site; a separate, explicit return site may be added later.
- A hotel cannot be activated for ordering without a valid active fulfilment site; deactivating a
  site is refused (or requires reassignment) while active hotels depend on it.
- Hotel records will reference `sites.id` (stable).

## 8. Carriers (decision, not implemented)

- Carriers are configured **per site** — not globally, not by hotel credentials.
- One carrier may serve several sites; one site may have several carriers.
- Per site: carrier accounts, sender and return addresses, pickup settings, available services,
  service priority, active/inactive.
- Credentials are **references to protected secrets**, never ordinary database values.
- A dispatch keeps a historical snapshot/reference of its origin site, carrier and selected
  service.
- A hotel may later choose among the services its fulfilment site permits; it never owns, sees or
  receives the site's carrier credentials. No carrier API (PPL, DHL, DPD) is implemented yet.

## 9. Limitations

- Warehouses are created by migration; a site created in the UI has no warehouse until then
  (`409 SITE_WITHOUT_WAREHOUSE`, the UI offers another site).
- One active site per session: browser tabs of one session share it.
- Label templates and artwork are company-wide brand data (changed only with
  `production:templates_manage`); everything operational in production is per site.
- No bottle transfer between sites exists in v0.1; a future transfer must be an explicit, audited
  business operation with its own records (the site of a bottle never changes in place).
- Hotel organization/site scopes (`HOTEL_ORGANIZATION`, `HOTEL_SITE`) remain reserved for the hotel
  portal.
