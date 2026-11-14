-- Pickup orders at the carrier ("svoz", doc 029 §11, owner 2026-11-14): one pickup of one site at
-- its registered sender address on one day, sent once to the carrier, with its plan of concrete
-- parcels (what the operator meant to hand over — never proof of a hand-over), and its one
-- cancellation at the carrier. Additive: new tables, their rules and a code counter; nothing
-- existing changes.

-- CreateEnum
CREATE TYPE "CarrierPickupStatus" AS ENUM ('PREPARED', 'SENT', 'ACCEPTED', 'CONFIRMED', 'REJECTED', 'NOT_CREATED', 'NOT_SENT');
CREATE TYPE "CarrierPickupCancelStatus" AS ENUM ('PREPARED', 'SENT', 'ACCEPTED', 'CONFIRMED', 'REJECTED', 'NOT_CREATED');

-- CreateTable
CREATE TABLE "carrier_pickups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "carrier_connection" TEXT NOT NULL,
    "carrier_environment" TEXT NOT NULL,
    "carrier_account" TEXT NOT NULL,
    "client_reference" TEXT NOT NULL,
    "pickup_date" DATE NOT NULL,
    "window_from" TEXT,
    "window_to" TEXT,
    "parcel_count" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CarrierPickupStatus" NOT NULL DEFAULT 'PREPARED',
    "carrier_ref" TEXT,
    "carrier_order_number" TEXT,
    "carrier_state" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "created_txid" BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),
    "sent_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution_reason" TEXT,
    "next_poll_at" TIMESTAMPTZ(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "carrier_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_pickup_parcels" (
    "pickup_id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "carrier_parcel_number" TEXT NOT NULL,

    CONSTRAINT "carrier_pickup_parcels_pkey" PRIMARY KEY ("pickup_id","parcel_id")
);

-- CreateTable
CREATE TABLE "carrier_pickup_cancellations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "pickup_id" UUID NOT NULL,
    "status" "CarrierPickupCancelStatus" NOT NULL DEFAULT 'PREPARED',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution_reason" TEXT,
    "carrier_state" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "next_poll_at" TIMESTAMPTZ(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "carrier_pickup_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carrier_pickups_serial_key" ON "carrier_pickups"("serial");
CREATE UNIQUE INDEX "carrier_pickups_code_key" ON "carrier_pickups"("code");
CREATE UNIQUE INDEX "carrier_pickups_client_reference_key" ON "carrier_pickups"("client_reference");
CREATE UNIQUE INDEX "carrier_pickups_operation_request_id_key" ON "carrier_pickups"("operation_request_id");
CREATE INDEX "carrier_pickups_site_id_pickup_date_idx" ON "carrier_pickups"("site_id", "pickup_date");
CREATE INDEX "carrier_pickup_parcels_parcel_id_idx" ON "carrier_pickup_parcels"("parcel_id");
CREATE INDEX "carrier_pickup_parcels_order_id_idx" ON "carrier_pickup_parcels"("order_id");
CREATE INDEX "carrier_pickup_cancellations_pickup_id_idx" ON "carrier_pickup_cancellations"("pickup_id");
-- One live cancellation per pickup: a refused one, or an uncertain one a person closed as not
-- carried out, may be followed by a new request.
CREATE UNIQUE INDEX "carrier_pickup_cancellations_one_per_pickup" ON "carrier_pickup_cancellations"("pickup_id")
  WHERE "status" NOT IN ('REJECTED', 'NOT_CREATED');
CREATE UNIQUE INDEX "carrier_pickup_cancellations_operation_request_id_key" ON "carrier_pickup_cancellations"("operation_request_id");
-- At most one pickup per site waits for the carrier: a pending or uncertain one blocks another
-- (never a second POST beside an unresolved one).
CREATE UNIQUE INDEX "carrier_pickups_one_unresolved_per_site" ON "carrier_pickups"("site_id")
  WHERE "status" IN ('PREPARED', 'SENT', 'ACCEPTED');

-- AddForeignKey
ALTER TABLE "carrier_pickups" ADD CONSTRAINT "carrier_pickups_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickups" ADD CONSTRAINT "carrier_pickups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickups" ADD CONSTRAINT "carrier_pickups_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickups" ADD CONSTRAINT "carrier_pickups_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_parcels" ADD CONSTRAINT "carrier_pickup_parcels_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "carrier_pickups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_parcels" ADD CONSTRAINT "carrier_pickup_parcels_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_parcels" ADD CONSTRAINT "carrier_pickup_parcels_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_parcels" ADD CONSTRAINT "carrier_pickup_parcels_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_cancellations" ADD CONSTRAINT "carrier_pickup_cancellations_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "carrier_pickups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_cancellations" ADD CONSTRAINT "carrier_pickup_cancellations_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_cancellations" ADD CONSTRAINT "carrier_pickup_cancellations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_pickup_cancellations" ADD CONSTRAINT "carrier_pickup_cancellations_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "code_counters" ("name", "last_value") VALUES ('carrier_pickup', 0);

-- ---------------------------------------------------------------------------------------------
-- Rules (also in the database)
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "carrier_pickups"
  ADD CONSTRAINT "carrier_pickups_code_check" CHECK ("code" = ayvo_format_code('SV-', "serial")),
  ADD CONSTRAINT "carrier_pickups_carrier_code_check" CHECK ("carrier_code" ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  ADD CONSTRAINT "carrier_pickups_environment_check" CHECK ("carrier_environment" IN ('TEST', 'PRODUCTION')),
  ADD CONSTRAINT "carrier_pickups_reference_check" CHECK ("client_reference" ~ '^[A-Za-z0-9-]{1,50}$'),
  ADD CONSTRAINT "carrier_pickups_parcels_check" CHECK ("parcel_count" >= 1),
  ADD CONSTRAINT "carrier_pickups_window_check" CHECK (
    ("window_from" IS NULL) = ("window_to" IS NULL)
    AND ("window_from" IS NULL OR (
      "window_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "window_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "window_from" < "window_to"))),
  -- Sent ⇔ claimed for sending at some time (a NOT_SENT pickup never was).
  ADD CONSTRAINT "carrier_pickups_sent_check" CHECK (("status" IN ('PREPARED', 'NOT_SENT')) = ("sent_at" IS NULL)),
  ADD CONSTRAINT "carrier_pickups_resolved_check" CHECK (("status" IN ('CONFIRMED', 'REJECTED', 'NOT_CREATED', 'NOT_SENT')) = ("resolved_at" IS NOT NULL)),
  -- Closed by a person (after checking with the carrier): who and why, only then.
  ADD CONSTRAINT "carrier_pickups_closed_check" CHECK (
    ("status" = 'NOT_CREATED') = ("resolved_by" IS NOT NULL)
    AND ("resolved_by" IS NULL) = ("resolution_reason" IS NULL)
    AND ("resolution_reason" IS NULL OR btrim("resolution_reason") <> '')),
  ADD CONSTRAINT "carrier_pickups_accepted_check" CHECK ("status" <> 'ACCEPTED' OR "carrier_ref" IS NOT NULL),
  ADD CONSTRAINT "carrier_pickups_rejected_check" CHECK ("status" NOT IN ('REJECTED', 'NOT_SENT') OR "error_code" IS NOT NULL),
  ADD CONSTRAINT "carrier_pickups_poll_check" CHECK ("next_poll_at" IS NULL OR "status" = 'ACCEPTED');

-- The pickup itself: what was ordered never changes; the status only moves forward
-- (PREPARED → SENT → ACCEPTED → CONFIRMED / REJECTED; SENT → CONFIRMED / REJECTED after a lookup,
-- or NOT_CREATED when a person closed an uncertain one after checking with the carrier;
-- PREPARED → NOT_SENT when its day or its plan no longer held before it was sent);
-- a confirmed pickup may still learn the carrier's number and state. Never deleted.
CREATE FUNCTION carrier_pickups_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: pickup orders are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."serial", NEW."code", NEW."site_id", NEW."carrier_code", NEW."carrier_connection",
      NEW."carrier_environment", NEW."carrier_account", NEW."client_reference", NEW."pickup_date",
      NEW."window_from", NEW."window_to", NEW."parcel_count", NEW."payload", NEW."created_at",
      NEW."created_by", NEW."operation_request_id", NEW."created_txid")
     IS DISTINCT FROM
     (OLD."serial", OLD."code", OLD."site_id", OLD."carrier_code", OLD."carrier_connection",
      OLD."carrier_environment", OLD."carrier_account", OLD."client_reference", OLD."pickup_date",
      OLD."window_from", OLD."window_to", OLD."parcel_count", OLD."payload", OLD."created_at",
      OLD."created_by", OLD."operation_request_id", OLD."created_txid") THEN
    RAISE EXCEPTION 'AYVO: an ordered pickup never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PREPARED' AND NEW."status" IN ('SENT', 'NOT_SENT'))
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'CONFIRMED', 'REJECTED', 'NOT_CREATED'))
    OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('CONFIRMED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'AYVO: pickup status % cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."carrier_ref" IS NOT NULL AND NEW."carrier_ref" IS DISTINCT FROM OLD."carrier_ref" THEN
    RAISE EXCEPTION 'AYVO: the carrier reference of a pickup never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('REJECTED', 'NOT_CREATED', 'NOT_SENT') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'AYVO: a refused, closed or unsent pickup is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CONFIRMED' AND (
       (OLD."carrier_order_number" IS NOT NULL AND NEW."carrier_order_number" IS DISTINCT FROM OLD."carrier_order_number")
    OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
    OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at") THEN
    RAISE EXCEPTION 'AYVO: a confirmed pickup only learns the carrier''s number and state' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "carrier_pickups_guard" BEFORE UPDATE OR DELETE ON "carrier_pickups"
  FOR EACH ROW EXECUTE FUNCTION carrier_pickups_guard();
CREATE TRIGGER "carrier_pickups_no_truncate" BEFORE TRUNCATE ON "carrier_pickups"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- A new pickup starts PREPARED, written by its own transaction (its plan only there — below).
CREATE FUNCTION carrier_pickups_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'PREPARED' OR NEW."sent_at" IS NOT NULL OR NEW."carrier_ref" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a pickup is written before it is sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."created_txid" <> pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'AYVO: a pickup records the transaction that writes it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "carrier_pickups_insert_check" BEFORE INSERT ON "carrier_pickups"
  FOR EACH ROW EXECUTE FUNCTION carrier_pickups_insert_check();

-- At commit: the pickup announces exactly its planned parcels.
CREATE FUNCTION carrier_pickups_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."parcel_count" <> (SELECT count(*) FROM "carrier_pickup_parcels" p WHERE p."pickup_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a pickup announces exactly its planned parcels' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "carrier_pickups_consistent" AFTER INSERT ON "carrier_pickups"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION carrier_pickups_consistent();

-- A planned parcel: written only by the transaction that wrote its pickup (the plan is fixed at
-- commit, also while the pickup is still PREPARED); a numbered parcel of a labelled shipment of the
-- pickup's site, carrier, environment and account, of its own order, not yet with the carrier.
-- Never changed or deleted.
CREATE FUNCTION carrier_pickup_parcels_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM "carrier_pickups" WHERE "id" = NEW."pickup_id";
  IF p."status" <> 'PREPARED' OR p."created_txid" <> pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'AYVO: the plan of a pickup is fixed when the pickup is written' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM "shipment_parcels" sp
        JOIN "shipments" s ON s."id" = sp."shipment_id"
        JOIN "orders" o ON o."id" = s."order_id"
       WHERE sp."id" = NEW."parcel_id" AND sp."shipment_id" = NEW."shipment_id"
         AND s."order_id" = NEW."order_id" AND o."site_id" = p."site_id"
         AND sp."carrier_parcel_number" = NEW."carrier_parcel_number"
         AND s."status" = 'LABELED'
         AND s."carrier_code" = p."carrier_code" AND s."carrier_connection" = p."carrier_connection"
         AND s."carrier_environment" = p."carrier_environment" AND s."carrier_account" = p."carrier_account") THEN
    RAISE EXCEPTION 'AYVO: a pickup plans only numbered parcels of labelled shipments of its site, carrier, environment and account' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "shipment_parcel_progress" g
              -- With the carrier = a pickup source (CARRIER, MANUAL, or CARRIER_IMPLIED by a delivery
              -- without a pickup scan, whose time stays unknown) — never by picked_up_at.
              WHERE g."parcel_id" = NEW."parcel_id" AND g."picked_up_source" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a parcel already with the carrier is not planned for a pickup' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "carrier_pickup_parcels_insert_check" BEFORE INSERT ON "carrier_pickup_parcels"
  FOR EACH ROW EXECUTE FUNCTION carrier_pickup_parcels_insert_check();
CREATE TRIGGER "carrier_pickup_parcels_immutable" BEFORE UPDATE OR DELETE ON "carrier_pickup_parcels"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "carrier_pickup_parcels_no_truncate" BEFORE TRUNCATE ON "carrier_pickup_parcels"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- The cancellation of a confirmed pickup at the carrier: one live per pickup, recorded before the
-- carrier is called; forward only (PREPARED → SENT → ACCEPTED → CONFIRMED / REJECTED; SENT →
-- ACCEPTED / CONFIRMED / REJECTED after a lookup; SENT / ACCEPTED → NOT_CREATED when a person,
-- after checking with the carrier, closed an uncertain attempt as not carried out — who, why);
-- confirmed only by the carrier; never deleted.
ALTER TABLE "carrier_pickup_cancellations"
  ADD CONSTRAINT "carrier_pickup_cancellations_reason_check" CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "carrier_pickup_cancellations_sent_check" CHECK (("status" = 'PREPARED') = ("sent_at" IS NULL)),
  ADD CONSTRAINT "carrier_pickup_cancellations_resolved_check" CHECK (("status" IN ('CONFIRMED', 'REJECTED', 'NOT_CREATED')) = ("resolved_at" IS NOT NULL)),
  ADD CONSTRAINT "carrier_pickup_cancellations_closed_check" CHECK (
    ("status" = 'NOT_CREATED') = ("resolved_by" IS NOT NULL)
    AND ("resolved_by" IS NULL) = ("resolution_reason" IS NULL)
    AND ("resolution_reason" IS NULL OR btrim("resolution_reason") <> '')),
  ADD CONSTRAINT "carrier_pickup_cancellations_rejected_check" CHECK ("status" <> 'REJECTED' OR "error_code" IS NOT NULL),
  ADD CONSTRAINT "carrier_pickup_cancellations_poll_check" CHECK ("next_poll_at" IS NULL OR "status" = 'ACCEPTED');

CREATE FUNCTION carrier_pickup_cancellations_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'PREPARED' OR NEW."sent_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a cancellation is written before it is sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "carrier_pickups" p WHERE p."id" = NEW."pickup_id" AND p."status" = 'CONFIRMED') THEN
    RAISE EXCEPTION 'AYVO: only a pickup confirmed by the carrier is cancelled at the carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION carrier_pickup_cancellations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: cancellations are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."pickup_id", NEW."reason", NEW."created_at", NEW."created_by", NEW."operation_request_id")
     IS DISTINCT FROM
     (OLD."id", OLD."pickup_id", OLD."reason", OLD."created_at", OLD."created_by", OLD."operation_request_id") THEN
    RAISE EXCEPTION 'AYVO: a requested cancellation never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PREPARED' AND NEW."status" = 'SENT')
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'CONFIRMED', 'REJECTED', 'NOT_CREATED'))
    OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('CONFIRMED', 'REJECTED', 'NOT_CREATED'))) THEN
    RAISE EXCEPTION 'AYVO: cancellation status % cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CONFIRMED', 'REJECTED', 'NOT_CREATED') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'AYVO: a resolved cancellation is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "carrier_pickup_cancellations_insert_check" BEFORE INSERT ON "carrier_pickup_cancellations"
  FOR EACH ROW EXECUTE FUNCTION carrier_pickup_cancellations_insert_check();
CREATE TRIGGER "carrier_pickup_cancellations_guard" BEFORE UPDATE OR DELETE ON "carrier_pickup_cancellations"
  FOR EACH ROW EXECUTE FUNCTION carrier_pickup_cancellations_guard();
CREATE TRIGGER "carrier_pickup_cancellations_no_truncate" BEFORE TRUNCATE ON "carrier_pickup_cancellations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
