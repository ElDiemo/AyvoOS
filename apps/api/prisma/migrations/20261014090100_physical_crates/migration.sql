-- Physical crates and their QR labels (doc 020 §3.4, ADR 0021 §6, doc 025 PR A1). Additive only:
-- new tables, one insert trigger on bottles that registers new bottle tokens in the shared QR
-- registry, new permissions and their grants. Existing rows are not changed: bottle tokens are
-- COPIED into qr_identities, bottles stay as they are. No crate, registration or print job is
-- created; crate cycles, assignments and filling are later PRs (doc 025 §9).

-- CreateEnum
CREATE TYPE "QrIdentityKind" AS ENUM ('BOTTLE', 'CRATE');

-- CreateEnum
CREATE TYPE "CrateStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CrateEventType" AS ENUM ('REGISTERED', 'LABEL_PRINT_JOB_CREATED');


-- CreateTable
CREATE TABLE "qr_identities" (
    "token" TEXT NOT NULL,
    "kind" "QrIdentityKind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_identities_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "crate_registrations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "crate_type_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "first_crate_serial" BIGINT NOT NULL,
    "last_crate_serial" BIGINT NOT NULL,
    "site_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "crate_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "qr_token" TEXT NOT NULL,
    "qr_kind" "QrIdentityKind" NOT NULL DEFAULT 'CRATE',
    "crate_type_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "CrateStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_label_print_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "label_count" INTEGER NOT NULL,
    "width_mm" INTEGER NOT NULL,
    "height_mm" INTEGER NOT NULL,
    "public_base_url" TEXT NOT NULL,
    "app_environment" "AppEnvironment" NOT NULL,
    "qr_error_correction" "QrErrorCorrectionLevel" NOT NULL,
    "status" "LabelPrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "file_storage_key" TEXT,
    "file_byte_size" INTEGER,
    "file_sha256" CHAR(64),

    CONSTRAINT "crate_label_print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_label_print_job_items" (
    "print_job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "crate_id" UUID NOT NULL,
    "qr_url" TEXT NOT NULL,

    CONSTRAINT "crate_label_print_job_items_pkey" PRIMARY KEY ("print_job_id","position")
);

-- CreateTable
CREATE TABLE "crate_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "crate_id" UUID NOT NULL,
    "type" "CrateEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "location_id" UUID,
    "operation_request_id" UUID NOT NULL,
    "registration_id" UUID,
    "print_job_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "crate_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qr_identities_token_kind_key" ON "qr_identities"("token", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "crate_registrations_serial_key" ON "crate_registrations"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "crate_registrations_code_key" ON "crate_registrations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "crate_registrations_operation_request_id_key" ON "crate_registrations"("operation_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "crate_registrations_id_site_id_key" ON "crate_registrations"("id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "crates_serial_key" ON "crates"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "crates_code_key" ON "crates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "crates_qr_token_key" ON "crates"("qr_token");

-- CreateIndex
CREATE INDEX "crates_site_id_serial_idx" ON "crates"("site_id", "serial");

-- CreateIndex
CREATE INDEX "crates_crate_type_id_idx" ON "crates"("crate_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "crate_label_print_jobs_serial_key" ON "crate_label_print_jobs"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "crate_label_print_jobs_code_key" ON "crate_label_print_jobs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "crate_label_print_jobs_operation_request_id_key" ON "crate_label_print_jobs"("operation_request_id");

-- CreateIndex
CREATE INDEX "crate_label_print_jobs_site_id_serial_idx" ON "crate_label_print_jobs"("site_id", "serial");

-- CreateIndex
CREATE INDEX "crate_label_print_job_items_crate_id_idx" ON "crate_label_print_job_items"("crate_id");

-- CreateIndex
CREATE UNIQUE INDEX "crate_label_print_job_items_print_job_id_crate_id_key" ON "crate_label_print_job_items"("print_job_id", "crate_id");

-- CreateIndex
CREATE INDEX "crate_events_crate_id_occurred_at_idx" ON "crate_events"("crate_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "crate_registrations" ADD CONSTRAINT "crate_registrations_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_registrations" ADD CONSTRAINT "crate_registrations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_registrations" ADD CONSTRAINT "crate_registrations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_registrations" ADD CONSTRAINT "crate_registrations_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crates" ADD CONSTRAINT "crates_qr_token_qr_kind_fkey" FOREIGN KEY ("qr_token", "qr_kind") REFERENCES "qr_identities"("token", "kind") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crates" ADD CONSTRAINT "crates_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crates" ADD CONSTRAINT "crates_registration_id_site_id_fkey" FOREIGN KEY ("registration_id", "site_id") REFERENCES "crate_registrations"("id", "site_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crates" ADD CONSTRAINT "crates_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_label_print_jobs" ADD CONSTRAINT "crate_label_print_jobs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_label_print_jobs" ADD CONSTRAINT "crate_label_print_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_label_print_jobs" ADD CONSTRAINT "crate_label_print_jobs_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_label_print_job_items" ADD CONSTRAINT "crate_label_print_job_items_print_job_id_fkey" FOREIGN KEY ("print_job_id") REFERENCES "crate_label_print_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_label_print_job_items" ADD CONSTRAINT "crate_label_print_job_items_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "crate_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_print_job_id_fkey" FOREIGN KEY ("print_job_id") REFERENCES "crate_label_print_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Shared QR registry (doc 020 §3.4): one token is never used by a bottle and a crate.
-- =============================================================================================

CREATE TRIGGER "qr_identities_immutable" BEFORE UPDATE OR DELETE ON "qr_identities"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "qr_identities_no_truncate" BEFORE TRUNCATE ON "qr_identities"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "qr_identities"
  ADD CONSTRAINT "qr_identities_token_check" CHECK ("token" ~ '^[A-Za-z0-9_-]{22}$');

-- Every new bottle or crate registers its token first; a token already used by any kind is a
-- unique violation and the insert (and its whole transaction) fails.
CREATE FUNCTION qr_identity_register() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'bottles' THEN
    INSERT INTO "qr_identities" ("token", "kind") VALUES (NEW."public_token", 'BOTTLE');
  ELSE
    INSERT INTO "qr_identities" ("token", "kind") VALUES (NEW."qr_token", 'CRATE');
  END IF;
  RETURN NEW;
END
$$;

-- Registry gap protection (PR #21 review): the old application may still create bottles while
-- this migration runs (scripts/deploy-dev.sh migrates before it swaps the API). The migration is
-- one transaction (Prisma applies each migration file as one; LOCK TABLE outside a transaction
-- block would fail loudly). Order: lock → trigger → copy, all before COMMIT:
-- - SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock of every INSERT: an insert that
--   started earlier is waited for (its row is then visible to the copy), a later one waits until
--   COMMIT and then runs with the trigger in place. Reads of bottles are not blocked.
-- - No bottle can be inserted between the copy and the trigger, so none can miss the registry.
-- Deploy impact: the lock is first queued behind bottle inserts already in progress; once held,
-- new bottle inserts wait until this migration commits. Expected to be brief, but the duration
-- depends on concurrent activity and on the number of existing bottles copied — no fixed bound.
LOCK TABLE "bottles" IN SHARE ROW EXCLUSIVE MODE;

CREATE TRIGGER "bottles_qr_identity" BEFORE INSERT ON "bottles"
  FOR EACH ROW EXECUTE FUNCTION qr_identity_register();

-- Existing bottle tokens are copied in; the bottle rows are not touched.
INSERT INTO "qr_identities" ("token", "kind", "created_at")
  SELECT "public_token", 'BOTTLE', "created_at" FROM "bottles";

-- =============================================================================================
-- Registrations and crates
-- =============================================================================================

INSERT INTO "code_counters" ("name", "last_value") VALUES ('crate', 0), ('crate_registration', 0);

ALTER TABLE "crate_registrations"
  ADD CONSTRAINT "crate_registrations_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "crate_registrations_code_check" CHECK ("code" = ayvo_format_code('CR-', "serial")),
  ADD CONSTRAINT "crate_registrations_quantity_check" CHECK ("quantity" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "crate_registrations_range_check"
    CHECK ("first_crate_serial" >= 1 AND "last_crate_serial" - "first_crate_serial" + 1 = "quantity");
CREATE TRIGGER "crate_registrations_immutable" BEFORE UPDATE OR DELETE ON "crate_registrations"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_registrations_no_truncate" BEFORE TRUNCATE ON "crate_registrations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "crates"
  ADD CONSTRAINT "crates_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "crates_code_check" CHECK ("code" = ayvo_format_code('AYV-C-', "serial")),
  ADD CONSTRAINT "crates_qr_kind_check" CHECK ("qr_kind" = 'CRATE'),
  -- Retirement is a later, approved workflow (doc 005): no crate is ever created retired.
  ADD CONSTRAINT "crates_status_check" CHECK ("status" = 'ACTIVE');

-- A crate is created inside its registration's serial range and with its type.
CREATE FUNCTION crates_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  reg "crate_registrations"%ROWTYPE;
BEGIN
  SELECT * INTO reg FROM "crate_registrations" WHERE "id" = NEW."registration_id";
  IF NEW."serial" NOT BETWEEN reg."first_crate_serial" AND reg."last_crate_serial"
     OR NEW."crate_type_id" IS DISTINCT FROM reg."crate_type_id" THEN
    RAISE EXCEPTION 'AYVO: crate does not match its registration' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "crates_insert_check" BEFORE INSERT ON "crates"
  FOR EACH ROW EXECUTE FUNCTION crates_insert_check();
CREATE TRIGGER "crates_qr_identity" BEFORE INSERT ON "crates"
  FOR EACH ROW EXECUTE FUNCTION qr_identity_register();
-- Nothing of a crate changes in this phase (status changes come with their own events later).
CREATE TRIGGER "crates_immutable" BEFORE UPDATE OR DELETE ON "crates"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crates_no_truncate" BEFORE TRUNCATE ON "crates"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Crate label print jobs (same lifecycle and QR policy as bottle print jobs, doc 016)
-- =============================================================================================

ALTER TABLE "crate_label_print_jobs"
  ADD CONSTRAINT "crate_label_print_jobs_serial_check" CHECK ("serial" >= 1),
  -- Shares the "PJ-" counter with bottle print jobs, so a PJ code is unique across both.
  ADD CONSTRAINT "crate_label_print_jobs_code_check" CHECK ("code" = ayvo_format_code('PJ-', "serial")),
  ADD CONSTRAINT "crate_label_print_jobs_label_count_check" CHECK ("label_count" BETWEEN 1 AND 1000),
  -- Physical size is chosen per job (not yet approved, doc 025 Q7); bounds of label templates.
  ADD CONSTRAINT "crate_label_print_jobs_size_check"
    CHECK ("width_mm" BETWEEN 20 AND 300 AND "height_mm" BETWEEN 20 AND 300),
  ADD CONSTRAINT "crate_label_print_jobs_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "crate_label_print_jobs_completed_check"
    CHECK ("status" <> 'COMPLETED'
       OR ("completed_at" IS NOT NULL AND "file_storage_key" IS NOT NULL
           AND "file_byte_size" > 0 AND "file_sha256" IS NOT NULL)),
  ADD CONSTRAINT "crate_label_print_jobs_failed_check"
    CHECK ("status" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL)),
  -- DEV/production QR separation (ADR 0014), the same rule as label_print_jobs.
  ADD CONSTRAINT "crate_label_print_jobs_qr_environment_check"
    CHECK (CASE WHEN "app_environment" = 'production'
                THEN "public_base_url" = 'https://qr.ayvo.co'
                ELSE coalesce(ayvo_url_host("public_base_url"), '') <> 'qr.ayvo.co'
                     AND coalesce(ayvo_url_host("public_base_url"), '') NOT LIKE '%.qr.ayvo.co' END);

CREATE FUNCTION crate_label_print_jobs_identity_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."serial" IS DISTINCT FROM OLD."serial"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
     OR NEW."label_count" IS DISTINCT FROM OLD."label_count"
     OR NEW."width_mm" IS DISTINCT FROM OLD."width_mm"
     OR NEW."height_mm" IS DISTINCT FROM OLD."height_mm"
     OR NEW."public_base_url" IS DISTINCT FROM OLD."public_base_url"
     OR NEW."app_environment" IS DISTINCT FROM OLD."app_environment"
     OR NEW."qr_error_correction" IS DISTINCT FROM OLD."qr_error_correction"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."operation_request_id" IS DISTINCT FROM OLD."operation_request_id" THEN
    RAISE EXCEPTION 'AYVO: print job identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "crate_label_print_jobs_identity_immutable" BEFORE UPDATE ON "crate_label_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION crate_label_print_jobs_identity_immutable();
CREATE TRIGGER "crate_label_print_jobs_no_delete" BEFORE DELETE ON "crate_label_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_label_print_jobs_no_truncate" BEFORE TRUNCATE ON "crate_label_print_jobs"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "crate_label_print_job_items"
  ADD CONSTRAINT "crate_label_print_job_items_position_check" CHECK ("position" >= 0);

-- Each label's QR URL is exactly the job's base URL + "/" + the crate's token (a reprint therefore
-- encodes the same URL), and a job prints only crates of its own site.
CREATE FUNCTION crate_label_print_job_items_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  expected text;
  same_site boolean;
BEGIN
  SELECT j."public_base_url" || '/' || c."qr_token", j."site_id" = c."site_id"
    INTO expected, same_site
    FROM "crate_label_print_jobs" j, "crates" c
   WHERE j."id" = NEW."print_job_id" AND c."id" = NEW."crate_id";
  IF expected IS DISTINCT FROM NEW."qr_url" THEN
    RAISE EXCEPTION 'AYVO: crate label QR URL does not match base URL and crate token'
      USING ERRCODE = 'check_violation';
  END IF;
  IF same_site IS NOT TRUE THEN
    RAISE EXCEPTION 'AYVO: a crate print job prints only crates of its site'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "crate_label_print_job_items_check" BEFORE INSERT ON "crate_label_print_job_items"
  FOR EACH ROW EXECUTE FUNCTION crate_label_print_job_items_check();
CREATE TRIGGER "crate_label_print_job_items_immutable" BEFORE UPDATE OR DELETE ON "crate_label_print_job_items"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_label_print_job_items_no_truncate" BEFORE TRUNCATE ON "crate_label_print_job_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Crate history (append-only, ADR 0006)
-- =============================================================================================

ALTER TABLE "crate_events"
  ADD CONSTRAINT "crate_events_reference_check"
    CHECK (CASE "type"
             WHEN 'REGISTERED' THEN "registration_id" IS NOT NULL AND "print_job_id" IS NULL
             WHEN 'LABEL_PRINT_JOB_CREATED' THEN "print_job_id" IS NOT NULL AND "registration_id" IS NULL
           END);

-- An event happens at the crate's site; a recorded location is a warehouse of that site; the
-- referenced registration or print job is the crate's own.
CREATE FUNCTION crate_events_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crates" c WHERE c."id" = NEW."crate_id" AND c."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: crate event site differs from the crate site' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."location_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "inventory_locations" l WHERE l."id" = NEW."location_id" AND l."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: crate event location is not a warehouse of its site' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."registration_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crates" c WHERE c."id" = NEW."crate_id" AND c."registration_id" = NEW."registration_id") THEN
    RAISE EXCEPTION 'AYVO: crate event references another registration' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."print_job_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_label_print_job_items" i
        WHERE i."print_job_id" = NEW."print_job_id" AND i."crate_id" = NEW."crate_id") THEN
    RAISE EXCEPTION 'AYVO: crate event references a print job without this crate' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "crate_events_check" BEFORE INSERT ON "crate_events"
  FOR EACH ROW EXECUTE FUNCTION crate_events_check();
CREATE TRIGGER "crate_events_immutable" BEFORE UPDATE OR DELETE ON "crate_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_events_no_truncate" BEFORE TRUNCATE ON "crate_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Every crate is born with its REGISTERED event in the same transaction.
CREATE FUNCTION crates_have_registered_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_events" e WHERE e."crate_id" = NEW."id" AND e."type" = 'REGISTERED') THEN
    RAISE EXCEPTION 'AYVO: crate % has no REGISTERED event', NEW."code" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "crates_have_registered_event" AFTER INSERT ON "crates"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crates_have_registered_event();

-- =============================================================================================
-- Permissions (doc 020 §12 as approved): crate data belongs to a site (doc 022), so both are
-- site-scoped. Printing crate labels is part of crates:register ("crates:register, crate
-- labels"). ADMIN holds every permission explicitly (doc 021).
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped") VALUES
  ('crates:read', 'Read physical crates of the site, their history and label print jobs', false, false, true),
  ('crates:register', 'Register physical crates and print or reprint their QR labels', false, false, true);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'crates:read'),
  ('ADMIN', 'crates:register'),
  ('PRODUCTION_SUPERVISOR', 'crates:read'),
  ('PRODUCTION_SUPERVISOR', 'crates:register'),
  ('WAREHOUSE_SUPERVISOR', 'crates:read'),
  ('WAREHOUSE_SUPERVISOR', 'crates:register'),
  ('PRODUCTION_OPERATOR', 'crates:read'),
  ('WAREHOUSE_OPERATOR', 'crates:read');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
