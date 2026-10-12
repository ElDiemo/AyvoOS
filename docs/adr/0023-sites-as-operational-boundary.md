# ADR 0023: Sites as the top-level operational boundary

- **Status:** Accepted — directed by the owner 2026-10-12; foundation implemented in Milestone 2C
  ([doc 022](../022-multi-site-foundation.md))
- **Date:** 2026-10-12
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Related:** [ADR 0022](0022-external-oidc-authentication.md) (authorization in AYVO OS),
  [ADR 0021](0021-crate-capacity-and-circulation-cycle.md) (crates), doc 007 (hotels), doc 008
  (deliveries)

## Context

AYVO will run several physical facilities across Europe — today a Czech facility, later e.g. a
German one. Warehouses, production, crate circulation, returns and dispatch happen at a facility.
Until now the application assumed a single warehouse (`MAIN`) and scoped users to warehouses only.
A country is not a facility (a country may get several), and a facility is not a legal entity
(legal entities, VAT registrations and invoicing identities are a billing concern).

## Decision

1. **`sites`** are AYVO's physical facilities and the top-level operational boundary: stable id,
   unique immutable code, name, country, address, IANA time zone, default locale and currency,
   capabilities (`WAREHOUSE`, `PRODUCTION`, `RETURNS`), active/inactive. Never deleted;
   deactivation keeps history readable, blocks new operational changes, and is refused while an
   operational invariant depends on the site.
2. **Every inventory location (warehouse) belongs to exactly one site** (immutable). Goods receipts
   record their site. Future operational records belong to a site too (doc 022 §6).
3. **Roles say what, scopes say where.** A user is scoped to sites; warehouse scopes only narrow a
   site the user already has (database-enforced). Global access is the explicit permission
   `sites:all_access` (ADMIN), evaluated by the authorization service — not a bypass and not one
   scope row per site.
4. **The active site** of a session is chosen by the user (automatically when there is only one),
   stored server-side on the session and validated against the scopes on every request. Site ids
   in URLs, queries, bodies, cookies or headers are never trusted for authorization.
5. **Identifiers stay globally unambiguous**: human codes come from global sequences (one
   database), so `GR-000123` cannot exist at two sites; a future site-aware prefix must be stable.
   Timestamps are stored in UTC and shown in the site's time zone.
6. **Hotels and fulfilment sites (decision recorded; not implemented):** a hotel's address/country
   and the AYVO site serving it are separate concepts; the serving site is never derived from the
   country. In v0.1 every hotel has exactly one active primary `fulfillment_site_id`; a hotel
   group may span hotels served by different sites. Planning, allocation, dispatch and crate
   circulation for a hotel order use the hotel's fulfilment site; an order stores an immutable
   reference/snapshot of it. Reassignment needs a reason and an audit event and affects only new
   orders — history (orders, shipments, crate cycles) is never rewritten. Returns route to the same
   site by default; a separate return site may be modelled explicitly later. A hotel cannot be
   activated for ordering without a valid active fulfilment site, and a site with active
   dependent hotels cannot be deactivated without reassignment.
7. **Carriers (decision recorded; not implemented):** carriers are configured per site, not
   globally and not by hotel credentials. One carrier may serve several sites and a site may use
   several carriers, each with site-specific accounts, sender/return addresses, pickup settings,
   available services, priority and active state. Credentials are references to protected
   secrets, never ordinary database values. A dispatch keeps a historical snapshot/reference of
   its origin site, carrier and service. Hotels may later choose among the services their
   fulfilment site permits; they never own, see or receive the site's carrier credentials.

## Consequences

### Positive

- A second facility needs data (a site, its warehouses, user scopes), not code changes.
- Cross-site data access is refused by one central guard, tested end to end.
- Future hotel, dispatch and carrier models have a stable site id to reference.

### Negative

- Warehouses are still created by migration (v0.1); a site created in the UI has no warehouse
  until one is added that way.
- Users of several sites choose a site before warehouse work; one session works at one site at a
  time (tabs share it).

## Alternatives considered

- **Country as the boundary** — rejected: a country may have several facilities; the hotel's
  country does not decide who serves it.
- **Warehouse-only scopes** (status quo) — rejected: production, returns and dispatch are site
  concerns, not warehouse concerns.
- **ADMIN as a code bypass** — rejected: global access must be explicit, auditable data.

## Open questions

- Warehouse creation UI and per-site warehouse selection beyond the default warehouse.
- Legal entities, VAT registrations and invoicing identities (billing milestone).
