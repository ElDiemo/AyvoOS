# ADR 0029: Carrier tracking as a source of facts — per-parcel progress, events without a user

- **Status:** Proposed — requested by the owner 2026-10-20 (order states and PPL tracking, doc
  031); needs the owner's review
- **Date:** 2026-10-20
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** extends doc 029 (dispatch) and ADR 0021 (crate circulation);
  ADR 0006 (append-only history) and ADR 0011 (reuse cycle) unchanged.

## Context

Until now, every fact in an order's and a crate's history was recorded by a signed-in user
(`order_events.actor_id`, `crate_events.actor_id` NOT NULL), and "Předáno dopravci" was a manual
confirmation for the whole order at once. The owner wants the order to become "Převzatá
dopravcem" and "Doručená" automatically from the carrier's tracking (PPL), per parcel, and only
when the carrier proves it. These facts have no user. Parcels of one order are picked up and
delivered at different times.

## Decision

1. **The carrier is a source of facts, not a user.** Order and crate events get a `source`
   (`USER` | `CARRIER`); `actor_id` is NULL exactly for `CARRIER` (DB CHECK). No fake "system
   user" is created. Each automatic look has its own operation request (kind
   `SHIPMENT_TRACKING_SYNC`) so the events stay grouped and traceable.
2. **What the carrier reported is stored as it reported it**: `shipment_tracking_events`
   (append-only) keeps the carrier's own numeric status, textual code, phase, group, wording,
   the event time and the time AYVO fetched it, plus our meaning from the documented code list.
   One row per parcel × status × code × event time, so repeated or late answers add nothing.
3. **Progress is per parcel and only moves forward**: `shipment_parcel_progress` (current
   state) records the pickup (`CARRIER` with its event, `MANUAL` from an earlier or fallback
   hand-over, or `CARRIER_IMPLIED` when a delivery comes without a pickup event — the time is
   then unknown and never invented) and the delivery (with its event). A trigger forbids
   clearing or changing a recorded step.
4. **Everything else follows the parcels, checked by the database at commit**: a crate cycle
   is `DISPATCHED` when its parcel is picked up and `DELIVERED` when it is delivered (a new
   cycle state); an order is `HANDED_TO_CARRIER` exactly when every parcel is picked up and
   `DELIVERED` exactly when every parcel is delivered. A shipment with any parcel at the carrier
   cannot be cancelled, so a cancellation never releases crates the carrier holds.
5. **Tracking runs in the existing background rounds** with its schedule in PostgreSQL
   (`shipment_tracking`: next look, failures with back-off, a lease), using the shipment's own
   carrier connection, environment and account — never the site's later settings.

## Consequences

- Readers of order and crate history must show `source = CARRIER` events as the carrier's (no
  user name).
- The manual "Předáno dopravci" stays as a fallback but is recorded as `MANUAL`, distinct from
  the carrier's proof; earlier manual hand-overs were backfilled as `MANUAL` pickups.
- `DELIVERED` does not complete a bottle's reuse cycle (ADR 0011): that still needs the return
  and individual identification. Returns, hotel portal, billing and ESG are not part of this.
- Only meanings documented in the carrier's own code list change states; unknown codes stay
  unknown (doc 031 §2, open questions to PPL in doc 031 §5).
