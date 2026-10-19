# 029 — Completing the order and preparing it for carrier pickup

Status (2026-10-19):

| Part                                                     | Implemented | Tested                                       | Deployed |
| -------------------------------------------------------- | ----------- | -------------------------------------------- | -------- |
| Order flow, shipment, parcels, labels, ready, hand-over  | yes (PR A)  | automated (API, DB rules, Playwright)        | no       |
| Carrier boundary, test-only carrier, polling, cancelling | yes (PR A)  | automated, with the test-only carrier        | no       |
| Site carrier settings (PPL), PPL CPL adapter             | PR B        | automated against a simulated PPL server     | no       |
| Real PPL test environment                                | —           | **not yet** (needs the test credentials, §5) | no       |
| Physical printing on the Zebra ZD220                     | —           | **open** (physical acceptance, §5)           | no       |

Scope approved by the owner on 2026-10-18 and 2026-10-19. Continues doc 028 (orders, picking) on
the same order; uses W1 (doc 025 §10) for weights and dimensions; implements the carrier boundary
planned in doc 008 and the per-site carrier rule of doc 022 §8.

Out of scope (not implemented, not pretended): delivery, returns, billing, the hotel portal, partial
or split shipments, ordering a pickup ("svoz" — a PPL pickup order is not our hotel order),
automatic printing (Raspberry Pi), the public QR passport, ESG, a production PPL connection.

## 1. One flow, on the order

Everything is on the order detail in **Expedice** — no separate shipment list, no second worklist,
no "create shipment" button: open the order → scan the finished crates → complete picking →
create the carrier labels → print and apply them → confirm **Připraveno k vyzvednutí** → after the
real hand-over confirm **Předáno dopravci**.

The order status is the **one** process status; the shipment records where the carrier request
stands. The database couples them, so they cannot contradict each other:

| Order status (UI)                            | Meaning                                                              | Shipment                                                          |
| -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `OPEN` (Otevřená / Rozpracovaná)             | picking                                                              | none                                                              |
| `READY_TO_DISPATCH` (Kompletace dokončena)   | picking complete; shipment and parcels derived automatically         | `DRAFT` → `REQUESTING` → `LABELED`; `CANCELLING` while cancelling |
| `READY_FOR_PICKUP` (Připraveno k vyzvednutí) | the operator confirmed the labels are printed and applied            | `LABELED`                                                         |
| `HANDED_TO_CARRIER` (Předáno dopravci)       | the operator confirmed the real hand-over; crate cycles `DISPATCHED` | `LABELED`                                                         |
| `CANCELLED`                                  | cancelled (only before anything reached a carrier)                   | cancelled                                                         |

None of these means "delivered", "the bottle is at the hotel" or "a completed reuse cycle"
(ADR 0011). A created or downloaded file is not evidence of printing; only the explicit
confirmation is. The bottles keep their status (`FILLED`); nothing moves stock.

## 2. Model (owner-approved: internal shipment, parcels and their audited history)

| Table                       | Purpose                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shipments`                 | `SHP-000001`; one live per order (the whole order together); carrier, **connection and environment recorded at the first request** (snapshot)    |
| `shipment_parcels`          | one per allocated crate (= one physical crate = one parcel = one label); allocation (so its bottles), crate, cycle, calculated reference, number |
| `shipment_parcel_weighings` | optional actual weighings, append-only, corrections keep the previous one; only before the labels are requested                                  |
| `shipment_carrier_requests` | each attempt: unique client reference, the payload sent **including the site's carrier settings used** (snapshot, no secrets), status, polling   |
| `shipment_labels`           | **one label file per parcel** and optionally the complete document; stored once, never replaced; PDF or ZPL with its DPI                         |

The shipment history is part of the order history (`order_events`). Delivery data are the
**order's snapshot** (doc 028); the sender comes from the site's carrier settings.

## 3. Rules

- **Derived, not entered:** completing the picking creates the shipment and one parcel per crate in
  loading order (same transaction).
- **Frozen content:** a completed order's crates cannot be removed (doc 028); while a carrier
  request is unresolved, labels exist or a cancellation runs, the order cannot be cancelled
  (`SHIPMENT_AT_CARRIER`) and no second shipment exists (one live per order). A draft that never
  reached a carrier is cancelled with the order.
- **At most one send per attempt:** the request is written first (`PREPARED`), then claimed by one
  conditional update (`SENT`) — only the claimer calls the carrier. A double click, a concurrent
  click or a replay finds the unresolved request and sends nothing.
- **Time limit:** every carrier call aborts after `CARRIER_CALL_TIMEOUT_SECONDS` (default 30 s);
  an aborted or answerless call is **unknown** (`NO_ANSWER`), never "failed", never re-sent.
- **In-flight window:** a claimed request may still be in flight for `CARRIER_SETTLE_SECONDS`
  (default 120 s, at least 3 × the time limit outside tests), measured **from `sent_at` in database
  time** regardless of any error code. Before it ends: no lookup and no manual closing; the UI
  shows from when "Ověřit" is possible.
- **Only the carrier settles an uncertain request:** "Ověřit u dopravce" looks it up by its
  references. Created → labels are fetched; the carrier itself confirms nothing was created →
  `NOT_CREATED`; the carrier cannot tell (e.g. PPL without a batch id, §5) → it **stays uncertain**.
  The passing of time never marks anything `NOT_CREATED` and nothing is re-created blindly.
- **Exceptional manual closing** (`shipments:resolve_uncertain`, ADMIN only; a reason and an
  explicit check box): a person who verified with the carrier that nothing was created closes an
  uncertain request (`NOT_CREATED`, `CLOSED_BY_PERSON`, audited) — a claimed one only after the
  in-flight window, an accepted one only after its automatic checks ended; never one the carrier
  reported as created. The UI offers it only when the server would allow it. The dialog states the
  risk: if a shipment does exist, the next request creates a **second** one at the carrier.
- **Asynchronous carriers:** an accepted request (`ACCEPTED`, e.g. a PPL batch id stored at once)
  is polled by a background worker: back-off 10 s, 20 s, 40 s … up to 5 min, at most 30 times; the
  state is in the database, so a restart continues; several API processes share the work
  (`SKIP LOCKED`). After the limit, a person checks with "Ověřit". The same applies to labels that
  could not be downloaded yet (`CREATED`).
- **Bounded, always:** every automatic round ends scheduled (counted) or stopped; problems that
  need a person (`CARRIER_PARCEL_MISMATCH`, `LABELS_INVALID`, `CARRIER_PARTIAL`) stop the polling;
  "Ověřit" looks a mismatch up again. Nothing is downloaded or stored unless the shipment is still
  `REQUESTING` (never during a cancellation); a user's inline processing holds a lease so the poller
  does not work on the same request at the same time.
- **Partly created set:** if the carrier creates only some parcels, the request stays `CREATED`
  (`CARRIER_PARTIAL`, no labels) and is cancelled at the carrier — every created number.
- **Late answers are never silent:** a carrier creation or cancellation confirmation arriving after
  the request or cancellation was closed locally is written to the history (`CARRIER_LATE_ANSWER`)
  and logged as an error, for a person to check with the carrier.
- **Carriers without cancellation** through their interface are not used for new shipments
  (`CANCELLATION_UNSUPPORTED`): otherwise a created-but-unusable shipment would have no way out.
- **Labels:** stored only after checking: each parcel's number is proven per parcel (never by
  position), each file really is PDF/ZPL (magic bytes), ≤ 5 MB. A mismatch keeps the request open
  (`CARRIER_PARCEL_MISMATCH`, `LABELS_INVALID`) for a person.
- **Cancelling the preparation:** first **recorded** (`CANCELLING`, reason, under the order lock);
  a ready-for-pickup order goes back to `READY_TO_DISPATCH`, so it cannot be handed over meanwhile;
  the database ties that step to the cancellation. Then the carrier is asked (with the request's own
  connection): its confirmation cancels (`carrier_cancelled_at`, a fresh draft of the same crates);
  only its **definitive** refusal (rejected request, or "not cancelled" after it accepted the
  request — e.g. already picked up) returns the shipment (`LABELED`, or `REQUESTING` for a created
  shipment whose labels never became usable, which then resumes its label download); "still
  processing" or a lost answer stays `CANCELLING` for "Ověřit zrušení".
  Never cancels the order, releases crates or returns stock. Actual weighings are entered again on
  the new draft.
- **Weights:** calculated reference per parcel (Hotovo snapshot or, without one, the references at
  derivation — labelled); optional actual weighing kept apart; the carrier gets the actual weight,
  else the reference, only where it uses weights and its unit is confirmed. Missing required data are
  shown and refused (`SHIPMENT_DATA_MISSING`), never 0 or invented; no carrier limit hard-coded.
- **Snapshots:** each request keeps the settings it used; later changes of the site's settings never
  change it; lookups, labels and cancellation use the request's connection and environment.

## 4. Carrier boundary

`apps/api/src/orders/carriers/carrier.ts`: `create` (once; refusal vs. unknown), `poll`, `labels`
(per parcel + complete), `cancel` (idempotent; may be asynchronous) and `cancelStatus`, plus the
carrier's rules. The registry gives the carrier for a **new** request at a site (from its settings)
and the carrier of an **existing** request (its connection and environment only).

- No site carrier, or the site's settings incomplete/disabled, or the server lacks the credentials:
  the order shows why ("Dopravce není pro tuto provozovnu připravený" + the reason); nothing is
  pretended.
- `CARRIER_PROVIDER=test` — a fake carrier for automated tests (labels "TEST CARRIER - NOT A REAL
  LABEL") — is refused unless `APP_ENV=test`.

## 5. PPL (CPL API) — facts from the authoritative documentation (ppl-cpl-api.apidog.io, 2026-10-19)

- OAuth2 client credentials (`scope=myapi2`), token 30 min, at most 12 tokens/min — reused until
  expiry. Test `https://api-dev.dhl.com/ecs/ppl/myapi2`; production URL exists but is **not used**.
- `POST /shipment/batch` → `201`, batch id only in the `Location` header (stored at once) →
  `GET /shipment/batch/{id}`: `importState` `Accepted | InProcess | Complete | Error`, each item with
  `shipmentNumber`, `labelUrl`, and set parcels as `relatedItems` (`relationType: ShipmentSet`).
- **Mapping parcels to crates:** batch status has no per-parcel index. Each set item therefore
  carries its own `externalNumbers` (`CUST` = our parcel reference); `GET /shipment` returns
  `externalNumbers` per shipment number → each number is mapped by that proof. If the proof is
  missing, the labels are not accepted (open for a person) — never mapped by position.
- **No idempotency key, duplicate `referenceId` behaviour and `CustomerReferences` matching are not
  documented**; a lost `Location` header has no documented lookup → such a request stays uncertain.
- Labels: `labelSettings.format` (`Pdf`/`Zpl`/…), `dpi` 203–1200 (ZPL); per-parcel `labelUrl`
  (`/data/{guid}`) on the same API host, Bearer token; batch valid ≤ 30 days (AYVO keeps a copy).
  Downloads go only to the configured API origin, without redirects, size-limited, content-checked.
- Weight per set item optional; **unit not documented** → not sent until PPL confirms it
  (mandatory towards Germany — DE is therefore not supported yet). No dimension fields.
- Latin characters only (examples contradict it) → diacritics are stripped in what is sent.
- Cancel `POST /shipment/{number}/cancel` → `202` (asynchronous) → confirmed only when `GET /shipment`
  shows `Canceled`.
- Pickup ordering is a separate endpoint (`/order/batch`) and is **not used**.

**Open questions for PPL** (also in the PR): duplicate `referenceId`; does `CustomerReferences`
match `referenceId` or `externalNumbers`; lookup of a batch after a lost `Location`; is each set
item's `externalNumbers` returned per parcel by `GET /shipment`; weight unit and precision; maximum
parcels per set (20 / 50 / 100 in different places); cancellation cut-off and behaviour for set
parcels; label size — e-mail 127 × 101 mm (CZ) / 150 × 101 mm (EU) vs. documentation 127 × 110 mm /
150 × 100 mm; which product codes our contract allows (`BUSS`?), and whether diacritics are accepted.

## 6. Permissions (catalogue migration; ADMIN only)

| Permission                    | Scope                    | Use                                                                          |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `shipments:read`              | active site, `WAREHOUSE` | the order's shipment, parcels, weights, labels, carrier numbers              |
| `shipments:prepare`           | active site, `WAREHOUSE` | actual weighing, create/resolve labels, ready for pickup, cancel preparation |
| `shipments:handover`          | active site, `WAREHOUSE` | confirm the hand-over to the carrier                                         |
| `shipments:resolve_uncertain` | active site, `WAREHOUSE` | the exceptional manual closing of an uncertain request (§3)                  |

Checked on every request, also on the repetition of the same request id; another site's order is
not found (404). Not warehouse-scoped (like orders, doc 028). `HOTEL_USER` stays unassignable.

## 7. UI

Order detail: hotel, number, site and delivery snapshot; **Další krok** with exactly one main action
for the current state or a truthful notice (no carrier and why, missing data, uncertain request
with the time from which it can be checked, carrier processing, cancellation running); the page
refreshes itself while the carrier may answer. **Balíky**: crate code, product, bottles, calculated
reference and its source, actual weighing (separately), package dimensions, carrier parcel number,
**each parcel's own label**, the complete document, the carrier's test-environment badge; collapsed
"Další možnosti" (cancel the preparation; the exceptional manual closing). Confirmations in dialogs
with an explicit check box. The hotel detail lists its orders with these statuses.

## 8. Implementation and tests

- Migrations `20261018090000_dispatch_enum_values`, `20261018090100_dispatch_shipments` (additive).
- API (`orders` module): `ShipmentsService`, `ShipmentCarrierFlow`, `ShipmentDeriver`,
  `ShipmentPoller`, `ShipmentsController`, carrier boundary and registry, the test-only carrier.
- `shipments.e2e.test.ts`: one and three crates, per-parcel labels mapped by the carrier's answer
  (answered in reverse order), missing weight, double click and concurrency, answers lost before and
  after the carrier, a hanging carrier cut off, asynchronous acceptance with polling continued by a
  second app instance ("restart"), a failed batch, the polling limit, labels downloaded later and
  checked before storing, the in-flight window in database time, the exceptional manual closing,
  cancellation recorded first / refused / lost / unsupported, concurrent cancel and hand-over, frozen
  content, `DISPATCHED`, no stock movement, database rules, W1 snapshots untouched, no carrier
  configured. `shipments-access.e2e.test.ts`: real sign-in, ADMIN only, per-step permissions incl.
  the exceptional one, permission removed before a replay, other site 404. Playwright
  `workflow-shipment.spec.ts`: the whole flow on a 390 px terminal incl. per-parcel labels;
  `workflow-dispatch.spec.ts`: mobile picking with the scanner focus.
