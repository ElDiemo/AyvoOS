# ADR 0031: Obchod as its own company function; sales access scoped by ownership

- **Status:** Proposed — owner request 2026-10-21 (doc 034), awaiting review in the PR
- **Date:** 2026-10-21
- **Related:** ADR 0020 (company functions), ADR 0023 (sites), ADR 0024 (custom roles), doc 021 §4c

## Context

Hotel acquisition happens before a hotel is a customer. A prospect has no site, warehouse or
carrier, and a salesperson works with the hotels assigned to them, not with an AYVO facility.
Until now the role SALES was a planned template with a warehouse availability permission.

## Decision

1. **Obchod** is a separate company function (navigation module) with its own tables (`sales_*`).
   Prospects are not operational hotels (doc 028). v1 never creates anything outside Obchod.
2. Sales access is **not site-scoped**. Two permissions:
   - `sales:work`: own prospects; the creator owns the prospect.
   - `sales:manage`: all prospects, and (re)assigning owners.

   Ownership is checked on the server for every read and write, including search, counts and
   duplicate warnings. A prospect the user may not see answers 404.

3. The system role SALES becomes assignable with `sales:work` only. Its former template permission
   `inventory:stock_summary` is removed, so a salesperson gets no warehouse, purchase-price,
   production, dispatch or user-administration access. FINANCE and HOTEL_USER stay planned.
4. History follows ADR 0006:
   - activities and events are append-only, and a correction is a new activity;
   - current-state rows (prospect, contact, task) carry a revision for optimistic concurrency and
     change together with their event.
5. Sales dates use one documented time zone (`Europe/Prague`) evaluated on the server.

## Consequences

- A future hand-over to operations (prospect → operational hotel) is a separate, explicit step to
  be designed later. Nothing links prospects to hotels now.
- Scoping by hotel groups (doc 021 §4c) can extend ownership later without changing the module
  boundary.
