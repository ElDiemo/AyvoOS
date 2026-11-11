# Hotel portal: deliveries (read only)

The third step of the owner's portal priority (2026-11-09), after the profile (doc 053) and the
contracts (doc 055). The hotel sees planned, in-progress and delivered deliveries, with states
taken from its real orders.

## Source and states

Orders of the hotel come from every serving site: the hotel sees its deliveries, not our sites.
Cancelled orders are not shown.

| Group       | Order status (doc 028/029/031) | State in the portal                  |
| ----------- | ------------------------------ | ------------------------------------ |
| Planned     | `OPEN`                         | Naplánováno (`PLANNED`)              |
| Planned     | `READY_TO_DISPATCH`            | Připravujeme k odeslání (`PREPARED`) |
| In progress | `READY_FOR_PICKUP`             | Čeká na převzetí dopravcem           |
| In progress | `HANDED_TO_CARRIER`            | Na cestě (`IN_TRANSIT`)              |
| Delivered   | `DELIVERED` (latest 20)        | Doručeno                             |

Per delivery the portal shows:

- the order code and the planned ship day;
- whether it came from the supply plan;
- products in whole crates and bottles;
- the moments the order was handed to the carrier and delivered.

Those moments are the order events `HANDED_TO_CARRIER` and `DELIVERED` (doc 031):

- from the carrier's tracking;
- or a hand-over confirmed by hand by AYVO staff (`source = USER`; its time is the confirmation).

Two cases have no time:

- When the carrier reported the pickup and the delivery in one go, only the delivery is shown.
- When a parcel's pickup time was never reported (TRACK39-R1, `pickupTimeUnknown`), the hand-over is
  shown without a time. Its event carries only the moment tracking saw it, and that is not shown as
  the hand-over time.

The ship day is a day of the serving site's time zone. Moments are shown in Europe/Prague, like every
portal time.

The portal never shows the serving site, crates, bottles, recipe or label versions, labels,
carrier accounts or connections, parcel numbers, people, cancel reasons or internal events.

## Implementation

- `OrdersService.portalDeliveries` (the orders module, exported) reads through the portal's pool.
  `GET /api/internal/v1/portal/hotels/:id/deliveries` checks the session and the grant on that
  hotel. A hotel not granted to the session answers 404.
- portal-web adds:
  - tabs "Profil" and "Dodávky" on the hotel;
  - "Nejbližší dodávka" on the profile: the first in progress, else the first planned;
  - `/hotels/<id>/deliveries` with the three groups, empty states and an unavailable state.

  The profile never fails because of deliveries.

## Owner decisions (2026-11-09)

- **Future plan days are shown**, so the hotel knows roughly when the next deliveries come.
  `upcoming` covers the days a switched-on supply plan still has from today for 60 days, in the
  serving site's time zone. It skips days that already have an order (those are shown as
  deliveries) and days that could not be ordered (an internal matter). Each day shows only the
  ship day and whole crates per product, and is marked as indicative. A paused or inactive plan
  shows nothing. `SupplyPlansService.portalUpcoming` owns this.
- **No tracking link or parcel number** is shown; it cannot be relied on.
- **Cancelled orders are not shown.**

No transit time is promised: the portal shows planned ship days, never an arrival estimate.
