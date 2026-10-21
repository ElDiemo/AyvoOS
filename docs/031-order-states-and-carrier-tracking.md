# 031 — Order states and automatic carrier tracking (PPL)

Requested and approved by the owner on 2026-10-20 as a separate unit after PR #38 (direct
printing). ADR 0029 records the architectural part (carrier-sourced facts, per-parcel progress).
Builds on doc 029 (dispatch) and doc 030 (printing). **Not verified against a real physical
pickup or delivery**: the PPL TEST environment holds no shipment that was ever picked up (§5).

## 1. The states the operator sees

| Order state (UI)            | Meaning                                                                                    | How it is reached                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Vytvořená**               | `OPEN`, no crate yet                                                                       | creating the order                                                                |
| **Rozpracovaná**            | `OPEN` with at least one crate — a display state, not a database state                     | the first scanned crate                                                           |
| **Kompletace dokončena**    | `READY_TO_DISPATCH`: every crate assigned and locked; labels are made, printed and applied | "Dokončit a vytisknout štítky" (doc 030)                                          |
| **Připravená k vyzvednutí** | `READY_FOR_PICKUP`: the operator explicitly confirmed the applied labels and readiness     | the operator's confirmation — printing never confirms it                          |
| **Převzatá dopravcem**      | `HANDED_TO_CARRIER`: every parcel is with the carrier                                      | automatically from the carrier's proof (§2); manual confirmation only as fallback |
| **Doručená**                | `DELIVERED`: the carrier confirmed the delivery of every parcel                            | automatically (§2)                                                                |
| **Stornovaná**              | `CANCELLED`                                                                                | cancelling the order (only while no parcel is with the carrier)                   |

Re-printing one stored label never changes the order and never creates a shipment (doc 030).
Delivery does **not** complete a bottle's reuse cycle (ADR 0011) — that needs the return and
individual identification, which do not exist yet.

## 2. What proves a pickup and a delivery (PPL CPL API)

Sources, read on 2026-10-20 (`ppl-cpl-api.apidog.io`): `GET /shipment` ("Slouží k získání
informací (trackingu) k zásilce"), `GET /codelist/status` ("Statusy zásilky /shipment"), `GET
/codelist/shipmentPhase` ("Fáze zásilky"). Owner-approved **read-only** calls to the PPL TEST
environment on 2026-10-20 19:21 UTC: both code lists (Accept-Language cs-CZ and en-US; 68 statuses,
8 phases) and `GET /shipment` for the existing, already cancelled test shipments 80256049251–257.
The answers are kept outside git in `/opt/ayvo/ppl-support/2026-10-20-tracking/` (no token or
credential in them). No shipment or pickup was created.

What the TEST answers show (and the documentation does not say):

- Each item of `trackAndTrace.events` carries a numeric **`statusId`** (not in the documented
  schema) equal to a `code` of `/codelist/status`, a textual `code` (e.g. `WaitingForShipment`,
  `Deleted.Cancelled`), `phase` (= `/codelist/shipmentPhase`), `group`, `eventDate` and `name`.
- **`shipmentState` is a comma-separated set of flags**: a shipment PPL never had reads
  `"Undelivered, DataShipment, Active, Canceled"`. It is therefore never used for a state.
- Czech and English names differ for some codes: 900 is "Čekáme na přijetí zásilky do přepravy"
  in Czech but "We received the parcel for delivery" in English, and 900 is what PPL records as
  soon as the shipment data exist. Meanings are taken from the **Czech** code list only.

The mapping (`apps/api/src/carriers/ppl/ppl-tracking.ts`), by `statusId`:

| statusId                        | PPL name (cs, code list 2026-10-20)                                                                                              | Meaning in AYVO | Effect                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------- |
| 150, 151                        | Zásilku jsme převzali od odesílatele.                                                                                            | **PICKED_UP**   | parcel picked up                          |
| 450, 451, 452, 453              | Zásilku jsme doručili příjemci.                                                                                                  | **DELIVERED**   | parcel delivered                          |
| 900, 933                        | Čekáme na přijetí zásilky do přepravy. / Aktivace zásilky                                                                        | DATA            | none                                      |
| 282, 300, 400, 405, 500, 710    | směřuje do cílové destinace / na doručujícím depu / připravena k doručení / dnes se doručuje / v přepravě / převzali do přepravy | IN_TRANSIT      | none (history)                            |
| 343, 461, 992                   | doručili na výdejní místo / připravíme k osobnímu odběru / Poste restante                                                        | PICKUP_POINT    | warning — **not a delivery to the hotel** |
| 454–460, 462–471, 476, 993      | nebyla doručena … / budeme doručovat v jiném termínu / odmítl převzetí …                                                         | NOT_DELIVERED   | warning                                   |
| 705, 997                        | nebyla doručena z důvodu ztráty / Zásilka ztracena                                                                               | LOST            | warning                                   |
| 336, 480, 718                   | nebyla vyzvednuta a bude vrácena / bude vrácena zpět odesílateli                                                                 | RETURNING       | warning                                   |
| 999                             | Zásilka je stornována v systému PPL.                                                                                             | CANCELLED       | none (history)                            |
| anything else, or no `statusId` | —                                                                                                                                | **UNKNOWN**     | kept and shown as unknown                 |

Neither shipment data, a generated label nor `Undelivered` is ever taken as a physical pickup.

## 3. Several parcels, history, consistency

- Each parcel is tracked by **its own verified carrier number**; the answer is matched by
  `shipmentNumber`, never by position. A number PPL does not return keeps its last known state
  and is marked as missing.
- The order shows e.g. "Převzato 1/3 · Doručeno 2/3". The order becomes "Převzatá dopravcem" only
  when every parcel is picked up, and "Doručená" only when every parcel is delivered (DB rule,
  ADR 0029).
- Once the carrier has a single parcel, neither the labels nor the order can be cancelled in
  the normal way (refused by the API and by a DB trigger), so no crate it holds is released.
- Each crate cycle follows its own parcel: `ALLOCATED → DISPATCHED` (picked up) `→ DELIVERED`.
- Events are stored with the original code, PPL as source, the event time and the fetch time.
  A repeated or late answer adds nothing (unique key) and never moves a state back. A delivery
  without a pickup event marks the parcel as picked up **with an unknown time**; a later pickup
  event fills in that time.
- An earlier manual "Předáno dopravci" stays recorded as `MANUAL` and is shown as "Předání ručně
  potvrzeno", distinct from the carrier's proof. The manual confirmation stays available as a
  fallback when tracking does not show the pickup.

## 4. Operation

- Automatic: the background rounds (every `CARRIER_POLL_SECONDS`) look at each labelled shipment
  whose order is ready, ready for pickup or handed over, every `CARRIER_TRACKING_SECONDS`
  (default 900 s = 15 min). Failures back off (doubling, at most 6 h) and pause after 12 in a
  row ("Obnovit tracking" resumes). The schedule and a lease (120 s) live in PostgreSQL, so a
  restart or several API processes simply continue; two looks never apply the same proof twice
  (order lock + unique key).
- Each look uses the **shipment's own** carrier connection, environment and account (ADR 0027),
  never the site's later settings. If that connection no longer exists, the look fails visibly.
- An outage keeps the last known state; the order shows the last successful check and the failed
  attempt. Tracking ends when every parcel is delivered.
- "Obnovit tracking" (`POST /api/admin/orders/{code}/shipment/tracking/refresh`) needs
  `shipments:handover` (those who confirm the hand-over), on the operational site only.

## 5. Not verified / questions for PPL

Not verified: a real physical pickup and a real delivery in PPL TEST (no picked-up shipment exists;
creating one or ordering a pickup was not authorised). Questions prepared for PPL:

1. Is **150/151** recorded for every parcel physically taken from the sender (also for parcels
   of a set, also for a regular collection), and what is the difference to **710** "Zásilku jsme
   převzali do přepravy"? Until answered, 710 does not count as the pickup.
2. Is `trackAndTrace.events[].statusId` a stable part of the API (it is not in the documented
   schema), and is `/codelist/status` the complete list of its values?
3. Do **450–453** always mean delivery to the addressee (not to a pick-up point), and why are
   there four codes?
4. After a delivery, can a later event (e.g. 454–469) still follow for the same parcel, and what
   does it mean?
5. Can events arrive late or out of order, and can an event's time change between two answers?

**Owner decisions (2026-10-21)** — formerly open:

- **A parcel picked up and not yet delivered keeps the serving site active.** Every earlier
  blocker stays (stock, warehouses, the last active site, hotels served, orders not yet handed
  over). The new blocker `PARCELS_IN_TRANSIT` counts orders whose live shipment has a parcel with
  a pickup (carrier, manual or implied) and no delivery — also a partial pickup (the order still
  "Připravená k vyzvednutí", then both blockers), and an order whose parcels are returning, lost,
  not delivered or at a pick-up point. The API check (`OrdersService`, registered with the site
  dependencies) and the database trigger `sites_deactivation_dependencies` (migration
  `20261021090200_site_parcels_in_transit`) say the same.
- **A return to the sender, a loss, a failed delivery attempt or a pick-up point is not a delivery
  to the hotel.** The order stays "Převzatá dopravcem"; the order detail shows the concrete problem
  on the affected parcel (its number, our reading of PPL's code and PPL's own text) as a warning.
  Nothing is cancelled, no crate is released, no stock is returned, and tracking goes on (every
  15 minutes, until every parcel is delivered or 12 looks in a row fail). A later delivery event
  of that parcel delivers it and the warning disappears. Physical returns are a separate, later
  stage; no claims process exists.

## 6. Tests

Simulated only (no real PPL): API tests with the test carrier (`test/order-tracking.e2e.test.ts`:
partial pickup and delivery of three parcels, delivery without pickup, unknown codes, a missing
parcel, outage with back-off and pause, concurrent looks, an expired lease, manual hand-over, DB
refusals, a site kept active by parcels in transit — partial pickup, return, loss, failed
attempt — until all are delivered), the PPL adapter against the simulated PPL shaped as the TEST answers
(`test/ppl-large-sets.test.ts`), access and site isolation (`test/shipments-access.e2e.test.ts`),
and the browser (`apps/web/e2e/workflow-tracking.spec.ts`: events written into the e2e database as
the carrier would report them, "Obnovit tracking", a parcel returning to the sender shown as a
warning on that parcel, desktop, 390 and 320 px).

Screenshots (`docs/screenshots/tracking/`, from `workflow-tracking.spec.ts` with
`AYVO_SCREENSHOT_DIR`): partial pickup (desktop), in transit with two delivered (desktop, 390,
320), delivered (390, 320). The dispatch screenshots (`docs/screenshots/shipment/`) show the
renamed states.

## 7. Boundaries

No physical returns, stock count, hotel portal, billing or ESG; the public QR passport is
unchanged; no new carrier.
