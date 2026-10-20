-- Direct printing (doc 030, ADR 0028): label variants, printers and print agents per site, the
-- durable print queue. Additive except the site carrier label format/resolution, which moved to the
-- printer (a carrier account is not a printer); DEV has no rows of that table yet.

-- =============================================================================================
-- 1. Label variants: the same carrier label in several formats (PDF for preview, ZPL for printing)
-- =============================================================================================

ALTER TABLE "shipment_labels" ADD COLUMN "carrier_ref" TEXT;
ALTER TABLE "shipment_labels"
  ADD CONSTRAINT "shipment_labels_carrier_ref_check" CHECK ("carrier_ref" IS NULL OR length("carrier_ref") BETWEEN 1 AND 200);

-- One file per parcel (or the complete document), format and resolution — never replaced.
DROP INDEX "shipment_labels_shipment_id_parcel_id_key";
DROP INDEX "shipment_labels_one_complete";
CREATE UNIQUE INDEX "shipment_labels_variant_key" ON "shipment_labels"
  ("shipment_id", COALESCE("parcel_id", '00000000-0000-0000-0000-000000000000'::uuid), "format", COALESCE("dpi", 0));
CREATE INDEX "shipment_labels_parcel_id_idx" ON "shipment_labels" ("parcel_id");

-- The first labels come from the shipment's unresolved request (as before); a further VARIANT of
-- the same labels (another format/resolution) only while the shipment is LABELED, from its succeeded
-- request, for a parcel that already has its label — never during or after a cancellation.
CREATE OR REPLACE FUNCTION shipment_labels_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."parcel_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipment_parcels" p WHERE p."id" = NEW."parcel_id" AND p."shipment_id" = NEW."shipment_id") THEN
    RAISE EXCEPTION 'AYVO: a parcel label belongs to a parcel of its shipment' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "shipment_carrier_requests" r JOIN "shipments" s ON s."id" = r."shipment_id"
              WHERE r."id" = NEW."request_id" AND r."shipment_id" = NEW."shipment_id"
                AND r."status" IN ('SENT', 'ACCEPTED', 'CREATED') AND s."status" = 'REQUESTING') THEN
    RETURN NEW;
  END IF;
  IF NEW."parcel_id" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "shipment_carrier_requests" r JOIN "shipments" s ON s."id" = r."shipment_id"
                  WHERE r."id" = NEW."request_id" AND r."shipment_id" = NEW."shipment_id"
                    AND r."status" = 'SUCCEEDED' AND s."status" = 'LABELED')
     AND EXISTS (SELECT 1 FROM "shipment_labels" l WHERE l."parcel_id" = NEW."parcel_id" AND l."request_id" = NEW."request_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AYVO: labels come from the shipment''s carrier request (variants only of a labelled shipment)' USING ERRCODE = 'check_violation';
END
$$;

-- Fetching a further variant (current state, one row per shipment and variant): leased, bounded.
CREATE TABLE "shipment_label_fetches" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "dpi" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "shipment_label_fetches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shipment_label_fetches_shipment_id_format_dpi_key" ON "shipment_label_fetches"("shipment_id", "format", "dpi");
CREATE INDEX "shipment_label_fetches_status_next_at_idx" ON "shipment_label_fetches"("status", "next_at");
ALTER TABLE "shipment_label_fetches" ADD CONSTRAINT "shipment_label_fetches_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_label_fetches"
  ADD CONSTRAINT "shipment_label_fetches_variant_check" CHECK ("format" = 'ZPL' AND "dpi" BETWEEN 203 AND 1200),
  ADD CONSTRAINT "shipment_label_fetches_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'FAILED')),
  ADD CONSTRAINT "shipment_label_fetches_attempts_check" CHECK ("attempts" >= 0);
CREATE TRIGGER "shipment_label_fetches_no_delete" BEFORE DELETE ON "shipment_label_fetches"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "shipment_label_fetches_no_truncate" BEFORE TRUNCATE ON "shipment_label_fetches"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- 2. The label format and resolution belong to the printer, not to the carrier settings
-- =============================================================================================
-- PRINT38-R1: the columns STAY (the previous application, still deployed while this migration
-- runs and the target of a rollback, reads and writes them). The new application no longer uses
-- them; it requests PDF from the carrier (ZPL follows per printer), so the compatible value is
-- PDF / 203 dpi — which the previous application then also uses. The check stays as it was.
UPDATE "site_carrier_settings" SET "label_format" = 'PDF', "label_dpi" = 203
 WHERE "label_format" <> 'PDF' OR "label_dpi" <> 203;

-- =============================================================================================
-- 3. Print agents (ADR 0028): a machine principal per site; only the token's hash is stored
-- =============================================================================================

CREATE TABLE "print_agents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "token_issued_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_version" TEXT,
    "detected_devices" JSONB,
    "detected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    CONSTRAINT "print_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "print_agents_code_key" ON "print_agents"("code");
CREATE UNIQUE INDEX "print_agents_token_hash_key" ON "print_agents"("token_hash");
CREATE UNIQUE INDEX "print_agents_id_site_id_key" ON "print_agents"("id", "site_id");
ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_agents"
  ADD CONSTRAINT "print_agents_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  ADD CONSTRAINT "print_agents_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "print_agents_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "print_agents_token_hint_check" CHECK ("token_hint" ~ '^[A-Za-z0-9_-]{4}$'),
  ADD CONSTRAINT "print_agents_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL));

CREATE FUNCTION print_agents_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: print agents are revoked, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."code", NEW."site_id", NEW."created_at", NEW."created_by")
     IS DISTINCT FROM (OLD."id", OLD."code", OLD."site_id", OLD."created_at", OLD."created_by") THEN
    RAISE EXCEPTION 'AYVO: a print agent''s identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash") THEN
    RAISE EXCEPTION 'AYVO: a revoked print agent stays revoked' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "print_agents_guard" BEFORE UPDATE OR DELETE ON "print_agents"
  FOR EACH ROW EXECUTE FUNCTION print_agents_guard();
CREATE TRIGGER "print_agents_no_truncate" BEFORE TRUNCATE ON "print_agents"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- 4. Printers per site: a physical device attached to one agent of the same site
-- =============================================================================================

CREATE TABLE "printers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "dpi" INTEGER NOT NULL,
    "connection" TEXT NOT NULL,
    "usb_serial" TEXT NOT NULL,
    "dispatch_default" BOOLEAN NOT NULL DEFAULT false,
    "auto_print" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reported_state" TEXT,
    "reported_detail" TEXT,
    "reported_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "printers_code_key" ON "printers"("code");
CREATE UNIQUE INDEX "printers_agent_id_usb_serial_key" ON "printers"("agent_id", "usb_serial");
CREATE INDEX "printers_site_id_idx" ON "printers"("site_id");
-- At most one default dispatch printer per site (and it is enabled).
CREATE UNIQUE INDEX "printers_one_dispatch_default" ON "printers" ("site_id") WHERE "dispatch_default";
ALTER TABLE "printers" ADD CONSTRAINT "printers_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The agent belongs to the printer's site.
ALTER TABLE "printers" ADD CONSTRAINT "printers_agent_id_site_id_fkey" FOREIGN KEY ("agent_id", "site_id") REFERENCES "print_agents"("id", "site_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "printers" ADD CONSTRAINT "printers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "printers" ADD CONSTRAINT "printers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "printers"
  ADD CONSTRAINT "printers_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  ADD CONSTRAINT "printers_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 100),
  -- The only supported device (doc 030 §3): Zebra ZD220 DT, native ZPL, 203 dpi, USB.
  ADD CONSTRAINT "printers_model_check" CHECK ("model" = 'ZEBRA_ZD220_DT' AND "language" = 'ZPL' AND "dpi" = 203 AND "connection" = 'USB'),
  ADD CONSTRAINT "printers_usb_serial_check" CHECK ("usb_serial" ~ '^[A-Za-z0-9._-]{1,64}$'),
  ADD CONSTRAINT "printers_default_enabled_check" CHECK (NOT "dispatch_default" OR "enabled"),
  ADD CONSTRAINT "printers_reported_state_check" CHECK ("reported_state" IS NULL OR "reported_state" IN ('READY', 'NOT_FOUND', 'ERROR'));

CREATE FUNCTION printers_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: printers are disabled, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."code", NEW."site_id", NEW."created_at", NEW."created_by")
     IS DISTINCT FROM (OLD."id", OLD."code", OLD."site_id", OLD."created_at", OLD."created_by") THEN
    RAISE EXCEPTION 'AYVO: a printer''s identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "printers_guard" BEFORE UPDATE OR DELETE ON "printers"
  FOR EACH ROW EXECUTE FUNCTION printers_guard();
CREATE TRIGGER "printers_no_truncate" BEFORE TRUNCATE ON "printers"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- 5. Print requests (the operator's decision) and print jobs (one per parcel label)
-- =============================================================================================

CREATE TABLE "print_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "site_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "parcel_id" UUID,
    "printer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_LABELS',
    "reason" TEXT,
    "duplicate_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "requested_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    CONSTRAINT "print_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "print_requests_operation_request_id_key" ON "print_requests"("operation_request_id");
CREATE INDEX "print_requests_shipment_id_idx" ON "print_requests"("shipment_id");
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_printer_id_fkey" FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_requests"
  ADD CONSTRAINT "print_requests_kind_check" CHECK (
    ("kind" = 'SHIPMENT' AND "parcel_id" IS NULL AND NOT "duplicate_acknowledged")
    OR ("kind" = 'REPRINT' AND "parcel_id" IS NOT NULL AND length(btrim(coalesce("reason", ''))) BETWEEN 3 AND 500)),
  ADD CONSTRAINT "print_requests_status_check" CHECK ("status" IN ('WAITING_FOR_LABELS', 'QUEUED', 'CANCELLED')),
  ADD CONSTRAINT "print_requests_resolved_check" CHECK (("status" = 'WAITING_FOR_LABELS') = ("resolved_at" IS NULL));

CREATE FUNCTION print_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: print requests are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'resolved_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'resolved_at']) THEN
    RAISE EXCEPTION 'AYVO: a print request is immutable except its resolution' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'WAITING_FOR_LABELS' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'AYVO: a resolved print request never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "print_requests_guard" BEFORE UPDATE OR DELETE ON "print_requests"
  FOR EACH ROW EXECUTE FUNCTION print_requests_guard();
CREATE TRIGGER "print_requests_no_truncate" BEFORE TRUNCATE ON "print_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE TABLE "print_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "print_request_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "printer_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "claim_token" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "print_jobs_serial_key" ON "print_jobs"("serial");
CREATE UNIQUE INDEX "print_jobs_code_key" ON "print_jobs"("code");
CREATE UNIQUE INDEX "print_jobs_print_request_id_parcel_id_key" ON "print_jobs"("print_request_id", "parcel_id");
CREATE INDEX "print_jobs_agent_id_status_idx" ON "print_jobs"("agent_id", "status");
CREATE INDEX "print_jobs_shipment_id_idx" ON "print_jobs"("shipment_id");
CREATE INDEX "print_jobs_parcel_id_idx" ON "print_jobs"("parcel_id");
-- One job of a parcel at a time on its way to a printer.
CREATE UNIQUE INDEX "print_jobs_one_active_per_parcel" ON "print_jobs" ("parcel_id") WHERE "status" IN ('QUEUED', 'CLAIMED', 'SENDING');
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_print_request_id_fkey" FOREIGN KEY ("print_request_id") REFERENCES "print_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "shipment_labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_fkey" FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "print_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_code_check" CHECK ("code" = ayvo_format_code('PRJ-', "serial")),
  ADD CONSTRAINT "print_jobs_status_check" CHECK ("status" IN ('QUEUED', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED')),
  ADD CONSTRAINT "print_jobs_claim_check" CHECK (("status" IN ('CLAIMED', 'SENDING')) <= ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL)),
  ADD CONSTRAINT "print_jobs_claim_token_check" CHECK ("claim_token" IS NULL OR "claim_token" ~ '^[A-Za-z0-9_-]{32,64}$'),
  ADD CONSTRAINT "print_jobs_started_check" CHECK (("status" IN ('SENDING', 'SENT', 'UNCERTAIN')) <= ("started_at" IS NOT NULL)),
  ADD CONSTRAINT "print_jobs_finished_check" CHECK (("status" IN ('SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED')) = ("finished_at" IS NOT NULL)),
  ADD CONSTRAINT "print_jobs_detail_check" CHECK ("detail" IS NULL OR length("detail") <= 1000);

-- Bound at creation: the stored ZPL of exactly this parcel, at the printer's resolution, of a
-- labelled shipment of the job's order and site; the printer's own agent; the request's printer.
CREATE FUNCTION print_jobs_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'AYVO: a print job starts QUEUED' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM "shipment_labels" l
         JOIN "shipment_parcels" p ON p."id" = l."parcel_id"
         JOIN "shipments" s ON s."id" = l."shipment_id"
         JOIN "printers" pr ON pr."id" = NEW."printer_id"
         JOIN "print_requests" rq ON rq."id" = NEW."print_request_id"
        WHERE l."id" = NEW."label_id" AND l."format" = 'ZPL' AND l."dpi" = pr."dpi"
          AND l."file_key" = NEW."file_key" AND l."sha256" = NEW."sha256" AND l."size_bytes" = NEW."size_bytes"
          AND l."parcel_id" = NEW."parcel_id" AND l."shipment_id" = NEW."shipment_id"
          AND p."shipment_id" = NEW."shipment_id"
          AND s."status" = 'LABELED' AND s."order_id" = NEW."order_id" AND s."site_id" = NEW."site_id"
          AND pr."site_id" = NEW."site_id" AND pr."agent_id" = NEW."agent_id" AND pr."enabled"
          AND EXISTS (SELECT 1 FROM "print_agents" a WHERE a."id" = NEW."agent_id" AND a."revoked_at" IS NULL)
          AND rq."printer_id" = NEW."printer_id" AND rq."shipment_id" = NEW."shipment_id"
          AND (rq."parcel_id" IS NULL OR rq."parcel_id" = NEW."parcel_id")) THEN
    RAISE EXCEPTION 'AYVO: a print job prints the stored ZPL of its own parcel on its request''s printer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "print_jobs_insert_check" BEFORE INSERT ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION print_jobs_insert_check();

-- Identity fixed; only the documented transitions (doc 030 §4); finished jobs never change.
CREATE FUNCTION print_jobs_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status', 'claim_token', 'claimed_at', 'lease_until', 'started_at', 'finished_at', 'detail'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: print jobs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a print job''s target is fixed at creation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'QUEUED' AND NEW."status" IN ('CLAIMED', 'CANCELLED'))
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('QUEUED', 'SENDING', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('SENT', 'FAILED', 'UNCERTAIN'))
    -- A late, truthful report of the agent after an unknown result.
    OR (OLD."status" = 'UNCERTAIN' AND NEW."status" IN ('SENT', 'FAILED'))) THEN
    RAISE EXCEPTION 'AYVO: print job % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('SENT', 'FAILED', 'CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'AYVO: a finished print job never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "print_jobs_guard" BEFORE UPDATE OR DELETE ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION print_jobs_guard();
CREATE TRIGGER "print_jobs_no_truncate" BEFORE TRUNCATE ON "print_jobs"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE TABLE "print_job_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_user_id" UUID,
    "agent_id" UUID,
    "detail" TEXT,
    CONSTRAINT "print_job_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "print_job_events_job_id_occurred_at_idx" ON "print_job_events"("job_id", "occurred_at");
ALTER TABLE "print_job_events" ADD CONSTRAINT "print_job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "print_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job_events" ADD CONSTRAINT "print_job_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job_events" ADD CONSTRAINT "print_job_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "print_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_job_events"
  ADD CONSTRAINT "print_job_events_status_check" CHECK ("status" IN ('QUEUED', 'CLAIMED', 'CLAIM_EXPIRED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED', 'START_REFUSED', 'LATE_REPORT')),
  ADD CONSTRAINT "print_job_events_actor_check" CHECK ("actor_user_id" IS NULL OR "agent_id" IS NULL),
  ADD CONSTRAINT "print_job_events_detail_check" CHECK ("detail" IS NULL OR length("detail") <= 1000);
CREATE TRIGGER "print_job_events_append_only" BEFORE UPDATE OR DELETE ON "print_job_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "print_job_events_no_truncate" BEFORE TRUNCATE ON "print_job_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

INSERT INTO "code_counters" ("name", "last_value") VALUES ('print_job', 0);

-- =============================================================================================
-- 6. Permissions (doc 030 §6): ADMIN only
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('printing:print', 'Print the carrier labels of an order of the active site on its dispatch printer (also automatically after completing it); download ZPL', false, false, true, 'WAREHOUSE'),
  ('printing:reprint', 'Print one parcel label again (an explicit, audited new print job; warns of a possible physical duplicate)', false, false, true, 'WAREHOUSE'),
  ('printing:manage', 'Manage printers and print agents of sites (agent tokens are shown once, stored only as a hash)', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'printing:print'),
  ('ADMIN', 'printing:reprint'),
  ('ADMIN', 'printing:manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
