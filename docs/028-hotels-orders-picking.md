# 028 — Hotels, manual orders and picking (first slice)

Status: **implemented (DEV), first slice** — scope approved by the owner on 2026-10-17.
**Continued by [doc 029](029-dispatch-to-carrier.md)** (shipment, labels, ready for pickup, handed
to the carrier): `READY_TO_DISPATCH` is now shown as "Kompletace dokončena" and is no longer the
end of the flow
("Hotely → Objednávky → Kompletace expedice"). Builds on doc 007 (hotels), doc 008 (service
deliveries), doc 022 §7 (fulfilment site) and the crate circulation of ADR 0021 / doc 025.

Out of scope (not implemented, not pretended): contracts, billing, commissions, ESG, hotel users
(HOTEL_USER stays a planned role), automatic proposals from rooms or frequency, carriers (PPL),
shipping labels, hand-over to a carrier, delivery, returns, and any change of the public QR
passport.

## 1. Model (minimal)

| Table                      | Purpose                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hotels`                   | `HT-000001`; name, one delivery address (line 1/2, postal code, city, country ISO-2), contact person, phone, e-mail, **fulfilment site** (`sites.id`), creator, operation id |
| `orders`                   | `ORD-000001`; hotel, **site** (the hotel's fulfilment site at creation), snapshot of hotel name, address and contact, requested ship day, status, completion/cancellation    |
| `order_lines`              | one per product: crates (whole), crate type + capacity snapshot, bottles = crates × capacity, `allocated_crates`                                                             |
| `order_crate_allocations`  | a concrete crate **cycle** assigned to a line; released (never deleted) on removal or cancellation                                                                           |
| `order_allocation_bottles` | the cycle's active bottle memberships at allocation time (insert-only) — the per-bottle trace                                                                                |
| `order_events`             | append-only order history: `CREATED`, `CRATE_ADDED`, `CRATE_REMOVED`, `COMPLETED`, `CANCELLED`                                                                               |

New crate cycle status **`ALLOCATED`** (ADR 0021 already lists it after `FILLED`) and crate events
`ALLOCATED_TO_ORDER` / `RELEASED_FROM_ORDER`. No other model, no stock movement, no bottle status
change: picking consumes nothing (the stock left the ledger at labelling and filling).

The bottle count is never a constant: `capacity` is copied from the crate type of the product's
**active recipe** when the order is created; a crate is accepted only for a cycle with the same
crate type and capacity.

## 2. States and transitions

Order: `OPEN → READY_TO_DISPATCH` ("Připraveno k expedici"), `OPEN → CANCELLED`,
`READY_TO_DISPATCH → CANCELLED`. `CANCELLED` is terminal. "Rozpracovaná kompletace" is an `OPEN`
order with at least one crate. There is no dispatched/delivered state yet.

Crate cycle: `FILLED → ALLOCATED` (crate scanned into an order), `ALLOCATED → FILLED` (removed
from an open order, or the order cancelled). An `ALLOCATED` cycle keeps exactly its capacity of
filled members: no supervised correction, refill, repack or abort applies to it (remove it from
the order first).

| Operation (idempotent per `requestId`) | Rule                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create hotel                           | fulfilment site chosen explicitly (never from the country), active, with the `WAREHOUSE` capability **and a really created warehouse**                                                                                                                                                                                       |
| Create order                           | at the **active site**, for a hotel served by it; requested ship day today or later (site time zone); ≥ 1 product, each once, whole crates ≥ 1; each product active with an active recipe                                                                                                                                    |
| Scan crate                             | order `OPEN` at the active site; the crate of this site; its cycle `FILLED` (Hotovo: capacity members, all filled); a line for its product with the same crate type/capacity **and, once the line holds a crate, the same recipe version and label design**; the line not yet complete. Re-scan: no change, answered as such |
| Remove crate                           | order `OPEN`; the active allocation released, cycle back to `FILLED`; no reason needed, author, time and crate always recorded                                                                                                                                                                                               |
| Complete picking                       | order `OPEN` and **every line exactly complete** → `READY_TO_DISPATCH`                                                                                                                                                                                                                                                       |
| Cancel (reason)                        | order `OPEN` or `READY_TO_DISPATCH`; all crates released (cycles `FILLED`); history kept                                                                                                                                                                                                                                     |

Any authorized worker of the site can continue an open picking (no personal lock).

## 3. Database invariants

- One active allocation per cycle (partial unique index) — a crate is never in two orders.
- `order_lines.allocated_crates BETWEEN 0 AND crates`, updated in the same transaction as the
  allocation (the row lock serialises concurrent scans; the CHECK refuses an over-allocation),
  and equal to the active allocations at commit.
- Allocation insert: order `OPEN`, cycle `ALLOCATED`, same site, product, crate type and capacity
  as its line. At commit: cycle `ALLOCATED` ⇔ one active allocation; the allocation's bottles are
  exactly the cycle's active members; `READY_TO_DISPATCH` ⇒ all lines complete; `CANCELLED` ⇒ no
  active allocation.
- Crate members cannot be released from an `ALLOCATED` cycle.
- Order snapshots, lines (except the counter), allocation bottles and events are immutable; nothing
  is deleted. Hotels: code and fulfilment site immutable, never deleted (reassignment with reason
  and audit is a later operation, doc 022 §7).
- Lock order: operation → order → crate → cycle.

## 4. Permissions (catalogue migration; granted to `ADMIN` only)

| Permission      | Scope                    | Use                                       |
| --------------- | ------------------------ | ----------------------------------------- |
| `hotels:read`   | company-wide             | hotel list and detail                     |
| `hotels:manage` | company-wide             | create a hotel                            |
| `orders:read`   | active site, `WAREHOUSE` | order overview and detail; hotel's orders |
| `orders:manage` | active site, `WAREHOUSE` | create and cancel orders                  |
| `orders:pick`   | active site, `WAREHOUSE` | scan, remove, complete picking            |

No existing role is extended and `HOTEL_USER` gets nothing. Orders of another site are invisible
(404) — on the hotel detail too, which lists only orders of the user's sites.

## 5. UI

Two modules: **Hotely** (list, new, detail with its orders) and **Expedice** (orders: Dnes /
Budoucí / Po termínu / Dokončené a stornované by the requested ship day in the site's time zone;
new order; detail with requested vs. loaded crates and bottles per product; picking).
The picking screen is for a mobile terminal: hotel and order always on top, large per-product
counters, a focused scan field, Czech errors, a retry of the same request after an uncertain answer.

## 6. Owner decisions (2026-10-17)

1. **Order number `ORD-000001`** — language-neutral for every country; only the word
   (Objednávka / Order / Bestellung) is translated. Internal ids unchanged; country, hotel and
   site are separate columns and are never derived from the number. (No `OR-` number existed
   anywhere — the slice was never deployed — so nothing was renumbered.)
2. **The fulfilment site needs a really created warehouse**, not only the `WAREHOUSE` capability
   (API, the site list of the form and the database trigger).
3. **Today or later, by the fulfilment site's time zone**; no back-dated orders. The form takes
   "today" from the server (`GET /api/admin/orders/calendar`), never from the device's clock.
4. **One order line never mixes recipe versions or label designs.** The first loaded crate pins
   them on the line (`order_lines.recipe_version_id`, `label_template_version_id`), every further
   crate must match (`LINE_VERSION_MISMATCH`, checked by the API and the database), and the pin is
   released only when the line is empty again. Different liquid lots between bottles are allowed —
   a lot is not a version.
5. **Removing a crate needs no reason**, but author, time and crate are always recorded (order
   event + released allocation). **Cancelling an order always needs a reason.**

## 6a. Review fixes (PR #29, Codex 2026-10-17)

- **Picking never loses a scan** (ORD-R1): the scan field never blocks; every QR is queued with
  its own stable request id and sent in order (the shared station queue). An uncertain answer stops
  the queue until "Zkusit znovu" sends the same attempt; unresolved attempts are kept in this tab's
  session storage across a reload, block removing crates and completing, and the existing leave
  guard holds back in-app links and the site switch before anything is sent.
- **Site deactivation** (ORD-R2): a site serving hotels (`HOTELS_SERVED`) or with orders still
  open or ready to dispatch (`ORDERS_NOT_CLOSED`) cannot be deactivated — modules register their
  checks with the sites module (no table access across modules); hotel and order creation take a
  share lock on the site row, so a concurrent deactivation never acts on a stale check; the
  database refuses it as well. No hotel deactivation/reassignment is introduced.
- **Paging** (ORD-R3): the order tabs and a hotel's orders are paged (`page`, `pageSize` ≤ 100,
  `total`) in a stable order; nothing is cut off silently.
- **One calendar day** (ORD-R4): see decision 3.

## 7. Implementation status (PR, 2026-10-17)

- API: `customers` (hotels) and `orders` modules; migrations `20261017090000_order_enum_values`,
  `20261017090100_hotels_orders_picking` (tables, triggers, permissions; nothing existing
  rewritten). Labelling, filling and supervised corrections refuse an allocated crate
  (`CRATE_ALLOCATED`).
- Web: modules **Hotely** (`/hotels`) and **Expedice** (`/dispatch`, picking at
  `/dispatch/orders/<code>/pick`) — owner-approved additions to the company functions of doc 019.
- Tests: `orders.e2e.test.ts` (rules, idempotency, concurrency, database invariants, no stock
  movement, warehouse requirement, version pins, paging beyond 200), `orders-access.e2e.test.ts`
  (real sign-in: ADMIN only, site isolation, resuming by another worker, deactivation blockers and
  their race with hotel creation), Playwright `workflow-dispatch.spec.ts` (whole flow on a
  390/320 px terminal; rapid scans with a held answer; answers lost before and after the commit;
  leave guard, site switch and reload; device time zones UTC+14 / UTC−11).
- Screenshots (synthetic data): `docs/screenshots/dispatch/`.
