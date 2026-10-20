# 032 — Hotel supply plans and automatic orders

Requested and approved by the owner on 2026-10-20 (overnight task) as one usable feature: a hotel
has a plan of regular deliveries; AYVO OS creates ordinary orders from it in the existing
Expedice; the operator picks and dispatches them as before. Builds on doc 028 (hotels, orders),
doc 029 (dispatch) and doc 031 (order states, tracking). No new order type and no new main module:
plans live in the `orders` module; the automatic part only **creates orders** — it never creates
a carrier shipment, orders a pickup, prints labels or ships anything.

## 1. The plan (approved scope, v1)

- **One plan per hotel**: validity from a date, an optional end, and a state — `INACTIVE`
  (new, the default), `ACTIVE`, `PAUSED`.
- **Rules**: product, a number of whole crates, and concrete days of the month (1–31). Example:
  soap 2 crates on days 1, 11, 21; gel 1 crate on days 5, 20.
- **A day that does not exist in a month** (e.g. 31 in November, 29–31 in February) is **not
  planned that month** — never moved to another day. The day picker says so and the preview shows
  every skipped day.
- **Same day**: the rules of one day make **one order**; the same product is **one line** with the
  sum of crates.
- **Days are local days of the hotel's fulfilment site** (its time zone, as every order's ship
  day, doc 028); the user's country or device never decides.
- No consumption forecast, no material reservation, no production order.

## 2. Preview before switching on

`POST …/supply-plan/preview` evaluates a plan (saved or being edited) for the next 30 days
**without writing anything**: per ship day the products, crates, bottles (crate type capacity of
the current recipe — never a constant 40), blockers, the hotel's existing orders that day
(possible overlap) and an order already created for that occurrence; plus every skipped day and a
summary "Co se bude vytvářet". A new plan is `INACTIVE`; switching it on needs an explicit
confirmation (`confirm: true`) by an authorised user.

## 3. Generating orders safely

- Runs in the application's existing background rounds (like carrier polling — no separate
  scheduler); `SUPPLY_PLAN_SECONDS` (default 300 s; 0 = off). Horizon: **14 calendar days**
  (today and the 13 following local days of the site). Never a ship day in the past; after an
  outage the missing future occurrences inside the horizon are simply created on the next round.
- **One occurrence (plan × local ship day) makes at most one order**: `supply_plan_occurrences`
  is unique per plan and day **in the database**; the order is created in the **same transaction**
  as its occurrence, completely or not at all, with the existing order rules (site with a
  warehouse, hotel of that site, active product, active recipe with a crate type, not in the
  past). A plan version change cannot bypass it (the key has no version). Concurrent rounds are
  serialised per plan (row lock) and the order's operation id is derived from the occurrence.
- A rule that cannot be fulfilled (archived product, no recipe, no warehouse, …) makes a visible
  **blocked occurrence** with its reason — never a partial order. It is tried again on later
  rounds while its day is in the horizon.
- The order stores its origin: `SUPPLY_PLAN`, the occurrence (plan, ship day, plan version and a
  snapshot of the lines used). Its creator is the user who switched the plan on (recorded in the
  order history as "z plánu zásobování").
- **Changing or pausing the plan** never rewrites or cancels orders already created; the UI says
  so and lists them. A **cancelled automatic order is not created again** for the same occurrence.
- **Manual orders stay possible** (an extra delivery when the hotel runs out); an order of the same
  hotel and day is not treated as a duplicate — the operator only sees a warning with the hotel's
  nearest orders. Nothing is merged or cancelled automatically.
- **Earlier dispatch**: a planned order may be prepared in advance; a user with `orders:manage`
  may change its ship day explicitly (reason, audit, order event). It keeps its link to the
  original occurrence, so the generator never creates a replacement; neither the plan nor other
  orders change. The planned ship day is not a guaranteed delivery day — delivery comes only from
  the carrier's events (doc 031).

## 4. Hotel detail

Sections: details (address, contacts, optional delivery note and receiving contact, serving
site), supply plan (state, rules, next ship day, last successful evaluation, blockers; technical
details collapsed), orders (manual / from the plan), deliveries per product and month (delivered
bottles and crates from **delivered parcels** and their stored content; ordered and not yet
delivered separately; a table and one chart). Nothing ordered, ready or handed over is shown as
delivered. No hotel portal, no `HOTEL_USER` access, no CO2/ESG or consumption.

## 5. Permissions and history

- Reading: `hotels:read` (hotel), `orders:read` at the hotel's serving site (plan, its orders,
  deliveries). Managing plans: new `orders:plan_manage` (site-scoped, **ADMIN only** for now).
  Changing a ship day: `orders:manage`. Optional hotel details: `hotels:manage`.
- Audited: plan created/saved (with a mandatory reason and the full snapshot), switched on,
  paused, every order created from an occurrence, ship day changes, hotel detail changes.
- Plans, previews and overviews never change stock or crate cycles and never call a carrier.

## 6. Decisions made while implementing (within the approved scope)

- The creator of an automatic order is the user who switched the plan on (orders need a person;
  the history says "Z plánu zásobování"). The background round itself has no user.
- Days are generated for **today and the 13 following local days**; a day that becomes past
  during a round is skipped.
- A plan rule may only pick an orderable product (active, with an active recipe and crate type);
  a rule whose product later stops being orderable stays visible in the editor and its days are
  blocked with that reason.
- Any refusal of the order rules blocks the day visibly (`ORDER_REFUSED` with the rule's code
  when it is not one of the known reasons); database or connection errors only fail the round,
  which tries again.
- Delivered bottles in the overview come from the crate content recorded when it was loaded into
  the order (`order_allocation_bottles`), so later returns never change a past figure.
- Changing a ship day is allowed in OPEN, READY_TO_DISPATCH and READY_FOR_PICKUP, to any day not
  in the past (earlier or later); the database allows it only before the hand-over.

## 7. Open questions / not verified

- Not decided by the owner (taken over from doc 031): whether orders "Převzatá dopravcem" keep a
  site active, and what happens with returning, lost or pick-up-point parcels.
- The delivered side of the overview chart is verified by API tests (a partly delivered order);
  the browser test sees only the honest empty chart, because creating delivered parcels in the
  browser test would need the full picking and carrier flow.
- Real PPL pickups and deliveries remain unverified (doc 031 §5).

Screenshots (`docs/screenshots/supply-plans/`, from `apps/web/e2e/workflow-supply-plan.spec.ts`):
hotel without a plan, plan with its 30-day preview, switched on with its orders, Expedice with
"Odeslat dne", an order from the plan after a ship day change, the manual order overlap, the hotel
with its plan, orders and deliveries — desktop, 390 and 320 px.
