-- Order states and automatic carrier tracking (doc 031, ADR 0029). Additive; existing rows keep
-- their meaning: an earlier manual hand-over is recorded as a MANUAL pickup of each parcel.

-- ---------------------------------------------------------------------------------------------
-- 1. Events recorded from the carrier have no user (ADR 0029): source CARRIER, actor NULL.
--    Every existing event is a USER event (default) — nothing is rewritten.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "order_events"
  ALTER COLUMN "actor_id" DROP NOT NULL,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'USER',
  ADD CONSTRAINT "order_events_source_check"
    CHECK ("source" IN ('USER', 'CARRIER') AND (("source" = 'USER') = ("actor_id" IS NOT NULL)));

ALTER TABLE "crate_events"
  ALTER COLUMN "actor_id" DROP NOT NULL,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'USER',
  ADD CONSTRAINT "crate_events_source_check"
    CHECK ("source" IN ('USER', 'CARRIER') AND (("source" = 'USER') = ("actor_id" IS NOT NULL)));

-- ---------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------

-- Tracking schedule of one labelled shipment (current state, mutable): when to look next, the
-- last successful look, consecutive failures and a lease (several API processes, restarts).
CREATE TABLE "shipment_tracking" (
    "shipment_id" UUID NOT NULL,
    "next_at" TIMESTAMPTZ(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    -- Parcel numbers the carrier did not return at the last successful look.
    "missing_numbers" TEXT[] NOT NULL DEFAULT '{}',
    "lease_until" TIMESTAMPTZ(3),
    "stopped_at" TIMESTAMPTZ(3),
    "stop_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_tracking_pkey" PRIMARY KEY ("shipment_id"),
    CONSTRAINT "shipment_tracking_failures_check" CHECK ("failures" >= 0),
    CONSTRAINT "shipment_tracking_stop_check" CHECK (
      ("stopped_at" IS NULL) = ("stop_reason" IS NULL)
      AND ("stop_reason" IS NULL OR "stop_reason" IN ('DELIVERED', 'CANCELLED', 'GAVE_UP'))
      AND (("stopped_at" IS NULL) = ("next_at" IS NOT NULL)))
);

-- One tracking event of one parcel, exactly as the carrier reported it (append-only): its own
-- numeric status, code, phase, group and wording, the event time, when AYVO fetched it, and our
-- meaning of it (doc 031 §2). A repeated or late answer adds nothing (unique key).
CREATE TABLE "shipment_tracking_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "carrier_environment" TEXT NOT NULL,
    "carrier_parcel_number" TEXT NOT NULL,
    "status_id" INTEGER,
    "code" TEXT,
    "phase" TEXT,
    "event_group" TEXT,
    "name" TEXT,
    "meaning" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_tracking_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shipment_tracking_events_meaning_check" CHECK ("meaning" IN
      ('DATA', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'PICKUP_POINT', 'NOT_DELIVERED', 'LOST',
       'RETURNING', 'CANCELLED', 'UNKNOWN'))
);
CREATE UNIQUE INDEX "shipment_tracking_events_once" ON "shipment_tracking_events"
  ("parcel_id", COALESCE("status_id", -1), COALESCE("code", ''), "occurred_at");
CREATE INDEX "shipment_tracking_events_shipment_id_occurred_at_idx" ON "shipment_tracking_events" ("shipment_id", "occurred_at");

-- Where each parcel is (current state, changed only together with the event that proves it):
-- picked up (by the carrier's event, by an earlier manual hand-over, or implied by a delivery
-- without a pickup event — then its time is unknown, never invented) and delivered.
CREATE TABLE "shipment_parcel_progress" (
    "parcel_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "picked_up_at" TIMESTAMPTZ(3),
    "picked_up_source" TEXT,
    "picked_up_event_id" UUID,
    "delivered_at" TIMESTAMPTZ(3),
    "delivered_event_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_parcel_progress_pkey" PRIMARY KEY ("parcel_id"),
    CONSTRAINT "shipment_parcel_progress_source_check" CHECK (
      "picked_up_source" IS NULL OR "picked_up_source" IN ('CARRIER', 'MANUAL', 'CARRIER_IMPLIED')),
    CONSTRAINT "shipment_parcel_progress_pickup_check" CHECK (
      ("picked_up_source" IS NULL AND "picked_up_at" IS NULL AND "picked_up_event_id" IS NULL)
      OR ("picked_up_source" = 'CARRIER' AND "picked_up_at" IS NOT NULL AND "picked_up_event_id" IS NOT NULL)
      OR ("picked_up_source" = 'MANUAL' AND "picked_up_at" IS NOT NULL)
      OR ("picked_up_source" = 'CARRIER_IMPLIED' AND "picked_up_at" IS NULL AND "picked_up_event_id" IS NULL
          AND "delivered_at" IS NOT NULL)),
    CONSTRAINT "shipment_parcel_progress_delivered_check" CHECK (
      ("delivered_at" IS NULL) = ("delivered_event_id" IS NULL)
      AND ("delivered_at" IS NULL OR "picked_up_source" IS NOT NULL))
);

ALTER TABLE "shipment_tracking" ADD CONSTRAINT "shipment_tracking_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_parcel_id_fkey"
  FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_parcel_progress" ADD CONSTRAINT "shipment_parcel_progress_parcel_id_fkey"
  FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_parcel_progress" ADD CONSTRAINT "shipment_parcel_progress_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_parcel_progress" ADD CONSTRAINT "shipment_parcel_progress_picked_up_event_id_fkey"
  FOREIGN KEY ("picked_up_event_id") REFERENCES "shipment_tracking_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_parcel_progress" ADD CONSTRAINT "shipment_parcel_progress_delivered_event_id_fkey"
  FOREIGN KEY ("delivered_event_id") REFERENCES "shipment_tracking_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3. Tracking events: append-only, each of its own parcel and number, its meaning proven.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION shipment_tracking_events_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "shipment_parcels" p JOIN "shipments" s ON s."id" = p."shipment_id"
        WHERE p."id" = NEW."parcel_id" AND p."shipment_id" = NEW."shipment_id"
          AND p."carrier_parcel_number" = NEW."carrier_parcel_number"
          AND s."carrier_code" = NEW."carrier_code" AND s."carrier_environment" = NEW."carrier_environment") THEN
    RAISE EXCEPTION 'AYVO: a tracking event belongs to its own parcel number and carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipment_tracking_events_insert_check" BEFORE INSERT ON "shipment_tracking_events"
  FOR EACH ROW EXECUTE FUNCTION shipment_tracking_events_insert_check();
CREATE TRIGGER "shipment_tracking_events_immutable" BEFORE UPDATE OR DELETE ON "shipment_tracking_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "shipment_tracking_events_no_truncate" BEFORE TRUNCATE ON "shipment_tracking_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE TRIGGER "shipment_tracking_no_delete" BEFORE DELETE ON "shipment_tracking"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "shipment_tracking_no_truncate" BEFORE TRUNCATE ON "shipment_tracking"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 4. Parcel progress: only forward. A pickup is recorded once (an implied one may later get its
--    proven time from a late pickup event); a delivery once; never undone.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION shipment_parcel_progress_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: parcel progress is never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "shipment_parcels" p WHERE p."id" = NEW."parcel_id" AND p."shipment_id" = NEW."shipment_id") THEN
      RAISE EXCEPTION 'AYVO: parcel progress belongs to its shipment' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."parcel_id" <> OLD."parcel_id" OR NEW."shipment_id" <> OLD."shipment_id" THEN
      RAISE EXCEPTION 'AYVO: parcel progress identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."picked_up_source" IS NOT NULL AND
       (NEW."picked_up_source", NEW."picked_up_at", NEW."picked_up_event_id")
         IS DISTINCT FROM (OLD."picked_up_source", OLD."picked_up_at", OLD."picked_up_event_id")
       AND NOT (OLD."picked_up_source" = 'CARRIER_IMPLIED' AND NEW."picked_up_source" = 'CARRIER') THEN
      RAISE EXCEPTION 'AYVO: a parcel pickup is recorded once' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."delivered_at" IS NOT NULL AND
       (NEW."delivered_at", NEW."delivered_event_id") IS DISTINCT FROM (OLD."delivered_at", OLD."delivered_event_id") THEN
      RAISE EXCEPTION 'AYVO: a parcel delivery is recorded once' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  -- A carrier-proven step comes from an event of this very parcel with that meaning.
  IF NEW."picked_up_event_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipment_tracking_events" e WHERE e."id" = NEW."picked_up_event_id"
          AND e."parcel_id" = NEW."parcel_id" AND e."meaning" = 'PICKED_UP' AND e."occurred_at" = NEW."picked_up_at") THEN
    RAISE EXCEPTION 'AYVO: a carrier pickup is proven by its own pickup event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."delivered_event_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipment_tracking_events" e WHERE e."id" = NEW."delivered_event_id"
          AND e."parcel_id" = NEW."parcel_id" AND e."meaning" = 'DELIVERED' AND e."occurred_at" = NEW."delivered_at") THEN
    RAISE EXCEPTION 'AYVO: a delivery is proven by its own delivery event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipment_parcel_progress_guard" BEFORE INSERT OR UPDATE OR DELETE ON "shipment_parcel_progress"
  FOR EACH ROW EXECUTE FUNCTION shipment_parcel_progress_guard();
CREATE TRIGGER "shipment_parcel_progress_no_truncate" BEFORE TRUNCATE ON "shipment_parcel_progress"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- The order and the parcel's crate cycle follow the progress (checked at commit).
CREATE FUNCTION shipment_parcel_progress_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  p record;
BEGIN
  SELECT sp."cycle_id", s."order_id" INTO p
    FROM "shipment_parcels" sp JOIN "shipments" s ON s."id" = sp."shipment_id"
   WHERE sp."id" = NEW."parcel_id";
  PERFORM ayvo_assert_crate_cycle(p."cycle_id");
  PERFORM ayvo_assert_order(p."order_id");
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "shipment_parcel_progress_consistent" AFTER INSERT OR UPDATE ON "shipment_parcel_progress"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipment_parcel_progress_consistent();

-- Once the carrier has any parcel, the labels are not cancelled (the order and its crates are no
-- longer released by a cancellation).
CREATE FUNCTION shipments_cancel_after_pickup() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "shipment_parcel_progress" pp
              WHERE pp."shipment_id" = NEW."id" AND pp."picked_up_source" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a shipment the carrier already has is not cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipments_cancel_after_pickup" BEFORE UPDATE OF "status" ON "shipments"
  FOR EACH ROW WHEN (NEW."status" IN ('CANCELLING', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION shipments_cancel_after_pickup();

-- ---------------------------------------------------------------------------------------------
-- 5. Orders: DELIVERED; HANDED_TO_CARRIER / DELIVERED follow every parcel (doc 031 §3).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "orders" DROP CONSTRAINT "orders_status_completed_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_status_completed_check" CHECK (
    ("status" NOT IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER', 'DELIVERED') OR "completed_at" IS NOT NULL)
    AND ("status" <> 'OPEN' OR "completed_at" IS NULL));

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','completed_at','completed_by','cancelled_at','cancelled_by','cancel_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: orders are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: an order snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'DELIVERED') THEN
    RAISE EXCEPTION 'AYVO: a % order never changes', OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'HANDED_TO_CARRIER' AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'AYVO: a handed-over order changes only to delivered' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The carrier's proof (every parcel) may move an order on even when "ready for pickup" was not
  -- confirmed; the commit-time check (ayvo_assert_order) requires exactly that proof.
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN' AND NEW."status" IN ('READY_TO_DISPATCH', 'CANCELLED'))
    OR (OLD."status" = 'READY_TO_DISPATCH' AND NEW."status" IN ('CANCELLED', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER', 'DELIVERED'))
    OR (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" IN ('READY_TO_DISPATCH', 'HANDED_TO_CARRIER', 'DELIVERED'))
    OR (OLD."status" = 'HANDED_TO_CARRIER' AND NEW."status" = 'DELIVERED')) THEN
    RAISE EXCEPTION 'AYVO: order % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND (NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
                                         OR NEW."completed_by" IS DISTINCT FROM OLD."completed_by") THEN
    RAISE EXCEPTION 'AYVO: an order''s completion is recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  -- "Ready for pickup" is withdrawn only by starting the cancellation of its labels.
  IF OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'READY_TO_DISPATCH' AND NOT EXISTS (
       SELECT 1 FROM "shipments" s WHERE s."order_id" = NEW."id" AND s."status" = 'CANCELLING') THEN
    RAISE EXCEPTION 'AYVO: ready for pickup is withdrawn only by cancelling the labels' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: lines exist; from READY_TO_DISPATCH on every line exactly complete and exactly one
-- live (non-cancelled) shipment — LABELED from READY_FOR_PICKUP on; OPEN and CANCELLED hold no
-- live shipment; CANCELLED holds no crate. HANDED_TO_CARRIER ⇔ every parcel picked up, not every
-- one delivered; DELIVERED ⇔ every parcel delivered; before that, at least one parcel not
-- picked up (doc 031 §3).
CREATE OR REPLACE FUNCTION ayvo_assert_order(p_order_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  o record;
  live int;
  live_status "ShipmentStatus";
  live_id uuid;
  parcels int;
  picked int;
  delivered int;
BEGIN
  SELECT * INTO o FROM "orders" WHERE "id" = p_order_id;
  IF NOT EXISTS (SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id) THEN
    RAISE EXCEPTION 'AYVO: an order has at least one line' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER', 'DELIVERED') AND EXISTS (
       SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id AND l."allocated_crates" <> l."crates") THEN
    RAISE EXCEPTION 'AYVO: % needs every line exactly complete', o."status" USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" = 'CANCELLED' AND EXISTS (
       SELECT 1 FROM "order_crate_allocations" a WHERE a."order_id" = p_order_id AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a cancelled order holds no crate' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), min(s."status"::text)::"ShipmentStatus", min(s."id"::text)::uuid INTO live, live_status, live_id
    FROM "shipments" s WHERE s."order_id" = p_order_id AND s."status" <> 'CANCELLED';
  IF o."status" IN ('OPEN', 'CANCELLED') AND live <> 0 THEN
    RAISE EXCEPTION 'AYVO: an % order has no live shipment', o."status" USING ERRCODE = 'check_violation';
  END IF;
  -- Orders completed before doc 029 have no shipment until their labels are requested.
  IF o."status" IN ('READY_FOR_PICKUP', 'HANDED_TO_CARRIER', 'DELIVERED') AND (live <> 1 OR live_status <> 'LABELED') THEN
    RAISE EXCEPTION 'AYVO: % needs its labelled shipment', o."status" USING ERRCODE = 'check_violation';
  END IF;
  IF live > 1 THEN
    RAISE EXCEPTION 'AYVO: an order has at most one live shipment' USING ERRCODE = 'check_violation';
  END IF;
  IF live = 1 THEN
    SELECT count(*), count(pp."picked_up_source"), count(pp."delivered_at") INTO parcels, picked, delivered
      FROM "shipment_parcels" p LEFT JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id"
     WHERE p."shipment_id" = live_id;
  ELSE
    parcels := 0; picked := 0; delivered := 0;
  END IF;
  IF o."status" = 'DELIVERED' AND (parcels = 0 OR delivered <> parcels) THEN
    RAISE EXCEPTION 'AYVO: a delivered order has every parcel delivered' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" = 'HANDED_TO_CARRIER' AND (parcels = 0 OR picked <> parcels OR delivered = parcels) THEN
    RAISE EXCEPTION 'AYVO: a handed-over order has every parcel with the carrier, not every one delivered' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP') AND parcels > 0 AND picked = parcels THEN
    RAISE EXCEPTION 'AYVO: an order whose every parcel is with the carrier is handed over' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Crate cycles: ALLOCATED → DISPATCHED (its parcel picked up) → DELIVERED (its parcel
--    delivered; ALLOCATED → DELIVERED when the pickup was implied). DELIVERED ends nothing else:
--    the bottles' reuse cycle is completed only by a return (ADR 0011).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "crate_cycles" DROP CONSTRAINT "crate_cycles_filled_at_check";
ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_filled_at_check"
    CHECK (("status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED')) = ("filled_at" IS NOT NULL));

CREATE OR REPLACE FUNCTION crate_cycles_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','member_count','filled_count','ready_to_fill_at','filled_at',
                          'aborted_at','aborted_by','abort_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: crate cycles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ABORTED' THEN
    RAISE EXCEPTION 'AYVO: an aborted crate cycle never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Returns do not exist yet: a delivered cycle does not change.
  IF OLD."status" = 'DELIVERED' THEN
    RAISE EXCEPTION 'AYVO: a delivered crate cycle does not change yet' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A cycle with the carrier changes only by its delivery (nothing else of it, ever).
  IF OLD."status" = 'DISPATCHED' AND (NEW."status" <> 'DELIVERED'
       OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')) THEN
    RAISE EXCEPTION 'AYVO: a dispatched crate cycle changes only to delivered' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" IN ('FILLING', 'ALLOCATED'))
    OR (OLD."status" = 'ALLOCATED' AND NEW."status" IN ('FILLED', 'DISPATCHED', 'DELIVERED'))
    OR (OLD."status" = 'DISPATCHED' AND NEW."status" = 'DELIVERED')) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLING' AND OLD."status" IN ('OPEN_ASSEMBLY', 'READY_TO_FILL') AND NEW."filled_count" < 1 THEN
    RAISE EXCEPTION 'AYVO: a crate enters FILLING only with a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- Allocation, its release, the dispatch and the delivery keep the finished crate exactly as it was.
  IF (OLD."status" IN ('ALLOCATED', 'DISPATCHED') OR NEW."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED'))
     AND (NEW."member_count" <> OLD."member_count" OR NEW."filled_count" <> OLD."filled_count"
          OR NEW."filled_at" IS DISTINCT FROM OLD."filled_at") THEN
    RAISE EXCEPTION 'AYVO: an allocated crate keeps its members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ayvo_assert_crate_cycle(p_cycle_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle record;
  active int;
  filled int;
  held_by text;
  progress record;
  expected text;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*), count(*) FILTER (WHERE b."status" = 'FILLED') INTO active, filled
    FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."cycle_id" = p_cycle_id AND a."released_at" IS NULL;
  IF cycle."member_count" <> active OR cycle."filled_count" <> filled THEN
    RAISE EXCEPTION 'AYVO: cycle counters %/% differ from % active and % filled members',
      cycle."member_count", cycle."filled_count", active, filled USING ERRCODE = 'check_violation';
  END IF;
  IF (cycle."status" = 'OPEN_ASSEMBLY' AND (active >= cycle."capacity" OR filled <> 0))
     OR (cycle."status" = 'READY_TO_FILL' AND (active <> cycle."capacity" OR filled <> 0))
     OR (cycle."status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED') AND (active <> cycle."capacity" OR filled <> cycle."capacity"))
     OR (cycle."status" = 'ABORTED' AND active <> 0) THEN
    RAISE EXCEPTION 'AYVO: cycle status % does not match % members / % filled of %',
      cycle."status", active, filled, cycle."capacity" USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'READY_TO_FILL' AND (cycle."ready_to_fill_at" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'READY_TO_FILL')) THEN
    RAISE EXCEPTION 'AYVO: READY_TO_FILL without its event' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED') AND NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'CRATE_FILLED'
          AND e."occurred_at" = cycle."filled_at") THEN
    RAISE EXCEPTION 'AYVO: FILLED only by Hotovo (its CRATE_FILLED event)' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'FILLING' AND NOT EXISTS (
       SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
        WHERE a."cycle_id" = p_cycle_id AND b."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a FILLING cycle has had a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- ALLOCATED, DISPATCHED or DELIVERED ⇔ held by exactly one active order allocation (doc 028);
  -- which of them follows the progress of its parcel in the live shipment (doc 031).
  SELECT o."status"::text INTO held_by
    FROM "order_crate_allocations" oa JOIN "orders" o ON o."id" = oa."order_id"
   WHERE oa."cycle_id" = p_cycle_id AND oa."released_at" IS NULL;
  IF (cycle."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED')) <> (held_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is ALLOCATED exactly while an order holds it' USING ERRCODE = 'check_violation';
  END IF;
  IF held_by IS NOT NULL THEN
    SELECT pp."picked_up_source", pp."delivered_at" INTO progress
      FROM "shipment_parcels" p JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
      LEFT JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id"
     WHERE p."cycle_id" = p_cycle_id;
    expected := CASE WHEN progress."delivered_at" IS NOT NULL THEN 'DELIVERED'
                     WHEN progress."picked_up_source" IS NOT NULL THEN 'DISPATCHED'
                     ELSE 'ALLOCATED' END;
    IF cycle."status"::text <> expected THEN
      RAISE EXCEPTION 'AYVO: a crate cycle is % while its parcel says %', cycle."status", expected
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION crate_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: assignments are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason','release_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason','release_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: an assignment changes only by its one release' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "crate_cycles" c WHERE c."id" = OLD."cycle_id" AND c."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED')) THEN
    RAISE EXCEPTION 'AYVO: a bottle never leaves a crate allocated to an order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The order's state changes check its crates at commit too.
DROP TRIGGER "orders_crates_dispatched" ON "orders";
CREATE CONSTRAINT TRIGGER "orders_crates_dispatched" AFTER UPDATE OF "status" ON "orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status" IN ('HANDED_TO_CARRIER', 'DELIVERED') OR OLD."status" IN ('HANDED_TO_CARRIER', 'DELIVERED'))
  EXECUTE FUNCTION orders_crates_dispatched();

-- ---------------------------------------------------------------------------------------------
-- 7. Existing data: an earlier manual hand-over stays what it was — a MANUAL pickup of every
--    parcel at the time of its HANDED_TO_CARRIER event (never a carrier proof). Labelled live
--    shipments get a tracking schedule (looked at on the next poll).
-- ---------------------------------------------------------------------------------------------

INSERT INTO "shipment_parcel_progress" ("parcel_id", "shipment_id", "picked_up_at", "picked_up_source", "updated_at")
SELECT p."id", s."id",
       (SELECT max(e."occurred_at") FROM "order_events" e WHERE e."order_id" = o."id" AND e."type" = 'HANDED_TO_CARRIER'),
       'MANUAL', CURRENT_TIMESTAMP
  FROM "orders" o
  JOIN "shipments" s ON s."order_id" = o."id" AND s."status" = 'LABELED'
  JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
 WHERE o."status" = 'HANDED_TO_CARRIER';

INSERT INTO "shipment_tracking" ("shipment_id", "next_at")
SELECT s."id", CURRENT_TIMESTAMP
  FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
 WHERE s."status" = 'LABELED' AND s."carrier_code" IS NOT NULL
   AND o."status" IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER');
