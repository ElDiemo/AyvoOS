# 029 — Completing the order and preparing it for carrier pickup

Status: **implemented (DEV, PR pending review)** — scope approved by the owner on 2026-10-18
("Dokončení objednávky a příprava k vyzvednutí dopravcem"). Continues doc 028 (orders, picking)
on the same order; uses W1 (doc 025 §10) for weights and dimensions; implements the carrier
boundary planned in doc 008 ("CarrierAdapter … carrier calls outside DB transactions, results
persisted with idempotency keys") and the per-site carrier rule of doc 022 §8.

Out of scope (not implemented, not pretended): delivery, returns, billing, the hotel portal, partial
or split shipments, ordering a pickup ("svoz"), automatic printing (Raspberry Pi), the public QR
passport and ESG. **No real carrier is connected yet**: PPL needs owner-provided access (§5).

## 1. One flow, on the order

Everything is on the order detail in **Expedice** — no separate shipment list, no second worklist,
no "create shipment" button:

1. open the order → 2. scan the finished crates (picking, doc 028) → 3. complete picking →
2. create the carrier labels → 5. print and apply them → 6. confirm **Připraveno k vyzvednutí** →
3. after the real hand-over confirm **Předáno dopravci**.

The order status is the **one** process status; the shipment records only where the carrier
request stands. The database couples them, so they cannot contradict each other:

| Order status (UI)                            | Meaning                                                                                    | Shipment                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `OPEN` (Otevřená / Rozpracovaná)             | picking                                                                                    | none                                                    |
| `READY_TO_DISPATCH` (Kompletace dokončena)   | picking complete; shipment and parcels derived automatically                               | `DRAFT` → `REQUESTING` → `LABELED` (or back to `DRAFT`) |
| `READY_FOR_PICKUP` (Připraveno k vyzvednutí) | the operator confirmed the labels are printed and applied                                  | `LABELED`                                               |
| `HANDED_TO_CARRIER` (Předáno dopravci)       | the operator confirmed the real hand-over; the crate cycles become `DISPATCHED` (ADR 0021) | `LABELED`                                               |
| `CANCELLED`                                  | cancelled (only before anything reached a carrier)                                         | cancelled                                               |

None of these means "delivered", "the bottle is at the hotel" or "a completed reuse cycle"
(ADR 0011). A created or downloaded PDF is not evidence of printing; only the explicit
confirmation is. The bottles keep their status (`FILLED`); nothing moves stock.

## 2. Model (owner-approved 2026-10-18: internal shipment, parcels and their audited history)

| Table                       | Purpose                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipments`                 | `SHP-000001`; one live (non-cancelled) per order — the whole order travels together; carrier code and its shipment reference recorded once                |
| `shipment_parcels`          | one per allocated crate (= one physical crate = one parcel = one label); links the allocation (and so its bottles), crate and cycle; calculated reference |
| `shipment_parcel_weighings` | optional actual weighings, append-only, corrections keep the previous one; only before the labels are requested                                           |
| `shipment_carrier_requests` | each attempt at the carrier: unique client reference, the payload sent (no secrets), status, answer                                                       |
| `shipment_labels`           | the carrier's label document, stored once (re-printing never contacts the carrier)                                                                        |

Shipment history is part of the order history (`order_events`): shipment created, labels
requested / created / refused / answer unknown / not created, parcel weighed, ready for pickup,
handed over, preparation cancelled.

Delivery data are the **order's snapshot** (doc 028), not the hotel as it is now. The sender is
the site's address.

## 3. Rules

- **Derived, not entered:** completing the picking creates the shipment and one parcel per crate in
  loading order (same transaction). Orders completed before this change get it when labels are
  first requested (the same derivation).
- **Frozen content:** a completed order's crates cannot be removed (doc 028); while a carrier
  request is unresolved or a shipment is labelled, the order cannot be cancelled
  (`SHIPMENT_AT_CARRIER`) and no second shipment exists (one live per order, unique index). A draft
  that never reached a carrier is cancelled together with the order.
- **Cancelling the preparation** ("Zrušit přípravu přepravy", reason): only for a labelled shipment
  and only when the carrier confirms the cancellation through its interface
  (`carrier_cancelled_at`; the database refuses a local-only cancellation). Then a fresh draft is
  derived from the same crates and the order is `READY_TO_DISPATCH` again. It never cancels the
  order, never releases its crates and never returns material to stock. A carrier without
  cancellation in its interface: `CARRIER_CANCEL_UNSUPPORTED`.
- **Carrier requests — at most one send per attempt:** the request is written first (`PREPARED`),
  then claimed by one conditional update (`SENT`) — only the claimer calls the carrier. A double
  click, a concurrent click or a replay of the same request id finds the unresolved request and
  sends nothing. A definitive refusal → `REJECTED`, back to draft. **No usable answer** (timeout,
  lost response) → stays `SENT` with `NO_ANSWER`, recorded, **never re-sent**; "Ověřit u dopravce"
  looks it up by its client reference: created → labels are fetched; the carrier confirms nothing
  was created → `NOT_CREATED`, a new attempt (new client reference) may follow; unknown → stays for
  a person. A request still possibly in flight (claimed, no outcome recorded, < 2 min) is not looked
  up. Asynchronous acceptance (e.g. a PPL batch) → `ACCEPTED`, polled, never re-sent. Created but
  labels not downloaded → `CREATED`, labels fetched again without a new shipment.
- **Weights:** each parcel carries the **calculated reference** of the finished package: the crate's
  Hotovo snapshot (W1, never rewritten) or — when it has none — the references in force when the
  shipment was derived, labelled as such; unknown stays unknown. The **actual weighing** is
  optional and kept apart; the carrier receives the actual weight if there is one, else the
  reference. No weighing is required unless the configured carrier requires a weight that is not
  known; then the missing data are shown and the request is refused (`SHIPMENT_DATA_MISSING`) —
  never 0 or an invented value. No carrier limit (e.g. 30 kg) is hard-coded.
- **Dimensions:** the outer dimensions of the final shipping package (W1) are shown per parcel and
  sent when the carrier uses them.

## 4. Carrier boundary

`apps/api/src/orders/carriers/carrier.ts`: `create` (sends once; refusal vs. unknown), `poll` (by
client reference / carrier reference), `labels`, `cancel`, and the carrier's rules (weight,
dimensions, sender address: required / optional / not used; cancellation supported). The registry
returns the carrier configured for a site, or none.

- **DEV and production today: no carrier** (`CARRIER_PROVIDER=none`, the default). The order shows
  "Dopravce není pro tuto provozovnu nastavený"; no label, number or success is ever pretended.
- `CARRIER_PROVIDER=test` — a fake carrier for automated tests (labels marked "TEST CARRIER - NOT A
  REAL LABEL") — is refused by the environment schema unless `APP_ENV=test`, like
  `AUTH_PROVIDER=test`.

## 5. PPL (CPL API) — what the official documentation says, and what is missing

Sources (2026-10-18): developer.ppl.cz, the PPL CPL API documentation (ppl-cpl-api-en.apidog.io /
ppl-cpl-api.apidog.io).

- REST "CPL API", OAuth2 client credentials (`scope=myapi2`); test `https://api-dev.dhl.com/ecs/ppl/myapi2`
  (separate database), production `https://api.dhl.com/ecs/ppl/myapi2`.
- **Asynchronous:** `POST /shipment/batch` → batch id in the `Location` header → poll
  `GET /shipment/batch/{id}` → shipment numbers and label URLs. Maps to `ACCEPTED` + `poll`.
- Multi-parcel **shipment set** (one master number, one number and label per parcel) — matches one
  shipment per order with one parcel per crate. The documented maximum parcels per set is
  inconsistent (20 / 50 / 100) — to be confirmed with PPL; not hard-coded.
- Per-parcel weight optional (mandatory towards Germany); **no dimension fields**; sender optional
  (registered address otherwise); only Latin characters (no diacritics).
- Labels PDF/ZPL/…, A4 (4 per page) or ≥ 127 × 110 mm thermal; re-downloadable while the batch is
  valid (≤ 30 days) — AYVO stores its copy.
- **No idempotency key documented.** `referenceId` is "unique", but the behaviour of a duplicate is
  not documented; lookup `GET /shipment?CustomerReferences=…` exists, but whether it matches
  `referenceId` is not documented; a lost batch id has no documented lookup. Until PPL answers, an
  unknown PPL outcome stays unresolved for a person (`poll` → `UNKNOWN`) — never re-sent.
- Cancellation `POST /shipment/{number}/cancel` → 202 (asynchronous; condition "before physical
  dispatch", cut-off undocumented). Pickup ordering exists (`POST /order/batch`) — not used.

**Needed from the owner** (credentials only into the server configuration, never into chat or git):
PPL contract and CPL API access for the **test** environment (client id / secret), the customer
number if PPL requires it, the sender/pickup address registered with PPL (and return address),
the product (e.g. `BUSS`) and services, the label format (A4 vs. thermal, printer DPI), and PPL's
written answers on: duplicate `referenceId`, lookup by `CustomerReferences`, maximum parcels per
set, cancellation cut-off, weight unit. External tests only in PPL's test environment with
synthetic data; no pickup orders, no live hotel data.

## 6. Permissions (catalogue migration; ADMIN only)

| Permission           | Scope                    | Use                                                                          |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `shipments:read`     | active site, `WAREHOUSE` | the order's shipment, parcels, weights, labels (PDF), carrier numbers        |
| `shipments:prepare`  | active site, `WAREHOUSE` | actual weighing, create/resolve labels, ready for pickup, cancel preparation |
| `shipments:handover` | active site, `WAREHOUSE` | confirm the hand-over to the carrier                                         |

Checked by the global guard on every request, also on the repetition of the same request id; an
order of another site is not found (404). Like orders (doc 028), not warehouse-scoped. No other
role gains them; `HOTEL_USER` stays a planned, unassignable role.

## 7. UI

Order detail: hotel, number, site and delivery snapshot as before; **Další krok** with exactly one
main action for the current state (or a truthful notice: no carrier, missing data, unresolved
request); **Balíky** — crate code, product, bottles, calculated reference (and its source), actual
weighing (separately), package dimensions, carrier parcel number, the stored labels ("Otevřít
štítky (PDF)") and, collapsed, "Zrušit přípravu přepravy"; confirmations in dialogs with an
explicit check box; history with the shipment events. The order overview keeps open, completed
and ready-for-pickup orders in the day tabs; "Předané a stornované" holds the closed ones. The
hotel detail lists its orders with these statuses. The crate shows "Předaná dopravci (na cestě, ne
u hotelu)".

## 8. Implementation (PR, 2026-10-18)

- Migrations `20261018090000_dispatch_enum_values`, `20261018090100_dispatch_shipments` (additive:
  new tables, triggers, stricter replacements of the order/cycle rule functions, permissions).
- API: `orders` module — `ShipmentsService`, `ShipmentsController`
  (`/api/admin/orders/:code/shipment…`), carrier boundary and the test-only carrier.
- Tests: `shipments.e2e.test.ts` (three crates → three parcels and labels, missing weight,
  double click, concurrency, answers lost before/after the carrier, in-flight request, refusal,
  asynchronous acceptance, label download retry, frozen content, ready for pickup, hand-over and
  `DISPATCHED`, cancellation through the carrier, no carrier configured, database rules, W1
  snapshots untouched, no stock movement), `shipments-access.e2e.test.ts` (real sign-in: ADMIN
  only, per-step permissions, permission removed before a replay, other site 404), Playwright
  `workflow-shipment.spec.ts` (the whole flow on a 390 px terminal; screenshots desktop / 390 /
  320 in `docs/screenshots/shipment/`).
- Waiting for: PPL access (adapter), a label printer (automatic printing).
