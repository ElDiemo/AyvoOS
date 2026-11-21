-- An uncertain pickup cancellation (SENT: its answer was not usable) is looked up automatically by
-- a read only (GET /order), like an accepted one: `next_poll_at` is its lease while a lookup runs
-- and its next due time afterwards (doc 029 §11, 2026-11-21). Only the check changes: SENT may now
-- carry a next lookup too. A resolved attempt still never does (the resolved check and the guard
-- are unchanged), and an older image never sets it for SENT and clears it on every resolution.
ALTER TABLE "carrier_pickup_cancellations"
  DROP CONSTRAINT "carrier_pickup_cancellations_poll_check",
  ADD CONSTRAINT "carrier_pickup_cancellations_poll_check"
    CHECK ("next_poll_at" IS NULL OR "status" IN ('SENT', 'ACCEPTED'));
