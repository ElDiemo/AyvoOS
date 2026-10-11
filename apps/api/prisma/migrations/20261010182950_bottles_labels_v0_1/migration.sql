-- CreateEnum
CREATE TYPE "LabelArtworkFormat" AS ENUM ('SVG', 'PNG', 'JPEG');

-- CreateEnum
CREATE TYPE "LabelElementType" AS ENUM ('QR_CODE');

-- CreateEnum
CREATE TYPE "BottleStatus" AS ENUM ('CREATED');

-- CreateEnum
CREATE TYPE "BottleEventType" AS ENUM ('CREATED');

-- CreateEnum
CREATE TYPE "AppEnvironment" AS ENUM ('development', 'test', 'production');

-- CreateEnum
CREATE TYPE "QrErrorCorrectionLevel" AS ENUM ('L', 'M', 'Q', 'H');

-- CreateEnum
CREATE TYPE "LabelPrintJobStatus" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "code_counters" (
    "name" TEXT NOT NULL,
    "last_value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "code_counters_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "label_artworks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "format" "LabelArtworkFormat" NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "intrinsic_width" DOUBLE PRECISION NOT NULL,
    "intrinsic_height" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_artworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "label_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_template_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "template_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "width_mm" DECIMAL(6,2) NOT NULL,
    "height_mm" DECIMAL(6,2) NOT NULL,
    "artwork_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_template_elements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "version_id" UUID NOT NULL,
    "type" "LabelElementType" NOT NULL,
    "position" INTEGER NOT NULL,
    "x_mm" DECIMAL(6,2) NOT NULL,
    "y_mm" DECIMAL(6,2) NOT NULL,
    "width_mm" DECIMAL(6,2) NOT NULL,
    "height_mm" DECIMAL(6,2) NOT NULL,
    "rotation_deg" INTEGER NOT NULL DEFAULT 0,
    "properties" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "label_template_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottle_creation_batches" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "quantity_requested" INTEGER NOT NULL,
    "quantity_created" INTEGER NOT NULL,
    "label_template_version_id" UUID NOT NULL,
    "first_bottle_serial" BIGINT NOT NULL,
    "last_bottle_serial" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bottle_creation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "public_token" TEXT NOT NULL,
    "status" "BottleStatus" NOT NULL,
    "creation_batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bottles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottle_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "bottle_id" UUID NOT NULL,
    "type" "BottleEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "creation_batch_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "bottle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_print_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "creation_batch_id" UUID NOT NULL,
    "label_template_version_id" UUID NOT NULL,
    "label_count" INTEGER NOT NULL,
    "public_base_url" TEXT NOT NULL,
    "app_environment" "AppEnvironment" NOT NULL,
    "qr_error_correction" "QrErrorCorrectionLevel" NOT NULL,
    "status" "LabelPrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "file_storage_key" TEXT,
    "file_byte_size" INTEGER,
    "file_sha256" CHAR(64),

    CONSTRAINT "label_print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_print_job_items" (
    "print_job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "bottle_id" UUID NOT NULL,
    "qr_url" TEXT NOT NULL,

    CONSTRAINT "label_print_job_items_pkey" PRIMARY KEY ("print_job_id","position")
);

-- CreateIndex
CREATE UNIQUE INDEX "label_artworks_storage_key_key" ON "label_artworks"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "label_templates_name_key" ON "label_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "label_template_versions_template_id_version_number_key" ON "label_template_versions"("template_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "label_template_elements_version_id_position_key" ON "label_template_elements"("version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "bottle_creation_batches_serial_key" ON "bottle_creation_batches"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "bottle_creation_batches_code_key" ON "bottle_creation_batches"("code");

-- CreateIndex
CREATE INDEX "bottle_creation_batches_label_template_version_id_idx" ON "bottle_creation_batches"("label_template_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottles_serial_key" ON "bottles"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "bottles_code_key" ON "bottles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "bottles_public_token_key" ON "bottles"("public_token");

-- CreateIndex
CREATE INDEX "bottles_creation_batch_id_serial_idx" ON "bottles"("creation_batch_id", "serial");

-- CreateIndex
CREATE INDEX "bottle_events_bottle_id_occurred_at_idx" ON "bottle_events"("bottle_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "label_print_jobs_serial_key" ON "label_print_jobs"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "label_print_jobs_code_key" ON "label_print_jobs"("code");

-- CreateIndex
CREATE INDEX "label_print_jobs_creation_batch_id_idx" ON "label_print_jobs"("creation_batch_id");

-- CreateIndex
CREATE INDEX "label_print_job_items_bottle_id_idx" ON "label_print_job_items"("bottle_id");

-- CreateIndex
CREATE UNIQUE INDEX "label_print_job_items_print_job_id_bottle_id_key" ON "label_print_job_items"("print_job_id", "bottle_id");

-- AddForeignKey
ALTER TABLE "label_template_versions" ADD CONSTRAINT "label_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "label_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_template_versions" ADD CONSTRAINT "label_template_versions_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "label_artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_template_elements" ADD CONSTRAINT "label_template_elements_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_creation_batches" ADD CONSTRAINT "bottle_creation_batches_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_creation_batch_id_fkey" FOREIGN KEY ("creation_batch_id") REFERENCES "bottle_creation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_creation_batch_id_fkey" FOREIGN KEY ("creation_batch_id") REFERENCES "bottle_creation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_creation_batch_id_fkey" FOREIGN KEY ("creation_batch_id") REFERENCES "bottle_creation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_print_job_items" ADD CONSTRAINT "label_print_job_items_print_job_id_fkey" FOREIGN KEY ("print_job_id") REFERENCES "label_print_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_print_job_items" ADD CONSTRAINT "label_print_job_items_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- =============================================================================================
-- Hand-written invariants (ADR 0009: constraints Prisma cannot express). Everything below is
-- documented in prisma/schema.prisma ("DB:" comments) and docs/015-data-dictionary.md.
-- =============================================================================================

-- --- Shared: code counters --------------------------------------------------------------------

ALTER TABLE "code_counters"
  ADD CONSTRAINT "code_counters_last_value_check" CHECK ("last_value" >= 0);

INSERT INTO "code_counters" ("name", "last_value") VALUES
  ('bottle', 0),
  ('bottle_creation_batch', 0),
  ('label_print_job', 0);

-- Human-readable code: PREFIX + serial zero-padded to 6 digits (wider once serial > 999999).
CREATE FUNCTION ayvo_format_code(prefix text, serial bigint) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT prefix || CASE WHEN serial < 1000000 THEN lpad(serial::text, 6, '0') ELSE serial::text END $$;

-- Generic guard: rejects UPDATE/DELETE/TRUNCATE on immutable tables.
CREATE FUNCTION ayvo_reject_modification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'AYVO: % on % is not allowed (immutable record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- --- labels: artworks, templates, versions, elements -------------------------------------------

ALTER TABLE "label_artworks"
  ADD CONSTRAINT "label_artworks_byte_size_check" CHECK ("byte_size" > 0),
  ADD CONSTRAINT "label_artworks_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "label_artworks_intrinsic_size_check" CHECK ("intrinsic_width" > 0 AND "intrinsic_height" > 0);

ALTER TABLE "label_templates"
  ADD CONSTRAINT "label_templates_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9_-]{0,63}$');

ALTER TABLE "label_template_versions"
  ADD CONSTRAINT "label_template_versions_version_number_check" CHECK ("version_number" >= 1),
  ADD CONSTRAINT "label_template_versions_size_check"
    CHECK ("width_mm" BETWEEN 10 AND 500 AND "height_mm" BETWEEN 10 AND 500);

ALTER TABLE "label_template_elements"
  ADD CONSTRAINT "label_template_elements_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "label_template_elements_geometry_check"
    CHECK ("x_mm" >= 0 AND "y_mm" >= 0 AND "width_mm" > 0 AND "height_mm" > 0),
  ADD CONSTRAINT "label_template_elements_rotation_check" CHECK ("rotation_deg" = 0),
  ADD CONSTRAINT "label_template_elements_qr_square_check"
    CHECK ("type" <> 'QR_CODE' OR "width_mm" = "height_mm");

-- An element must lie entirely on its label.
CREATE FUNCTION label_template_elements_within_bounds() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v record;
BEGIN
  SELECT "width_mm", "height_mm" INTO v FROM "label_template_versions" WHERE "id" = NEW."version_id";
  IF NEW."x_mm" + NEW."width_mm" > v."width_mm" OR NEW."y_mm" + NEW."height_mm" > v."height_mm" THEN
    RAISE EXCEPTION 'AYVO: label element lies outside the label' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "label_template_elements_within_bounds"
  BEFORE INSERT ON "label_template_elements"
  FOR EACH ROW EXECUTE FUNCTION label_template_elements_within_bounds();

-- Template versions are immutable snapshots: historical print output must never change.
CREATE TRIGGER "label_artworks_immutable" BEFORE UPDATE OR DELETE ON "label_artworks"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "label_template_versions_immutable" BEFORE UPDATE OR DELETE ON "label_template_versions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "label_template_elements_immutable" BEFORE UPDATE OR DELETE ON "label_template_elements"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "label_templates_no_delete" BEFORE DELETE ON "label_templates"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();

-- A template's identity never changes; only archived_at (active ↔ archived) may.
CREATE FUNCTION label_templates_identity_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'AYVO: label template identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "label_templates_identity_immutable" BEFORE UPDATE ON "label_templates"
  FOR EACH ROW EXECUTE FUNCTION label_templates_identity_immutable();

-- --- assets: creation batches, bottles, events ------------------------------------------------

ALTER TABLE "bottle_creation_batches"
  ADD CONSTRAINT "bottle_creation_batches_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "bottle_creation_batches_code_check" CHECK ("code" = ayvo_format_code('BC-', "serial")),
  ADD CONSTRAINT "bottle_creation_batches_quantity_check"
    CHECK ("quantity_requested" BETWEEN 1 AND 1000 AND "quantity_created" = "quantity_requested"),
  ADD CONSTRAINT "bottle_creation_batches_range_check"
    CHECK ("first_bottle_serial" >= 1
       AND "last_bottle_serial" - "first_bottle_serial" + 1 = "quantity_created");

ALTER TABLE "bottles"
  ADD CONSTRAINT "bottles_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "bottles_code_check" CHECK ("code" = ayvo_format_code('AYV-B-', "serial")),
  ADD CONSTRAINT "bottles_public_token_check" CHECK ("public_token" ~ '^[A-Za-z0-9_-]{22}$');

ALTER TABLE "bottle_events"
  ADD CONSTRAINT "bottle_events_created_context_check"
    CHECK ("type" <> 'CREATED' OR "creation_batch_id" IS NOT NULL);

-- Exactly one CREATED event per bottle (the "at least one" half is the creation transaction).
CREATE UNIQUE INDEX "bottle_events_one_created_per_bottle"
  ON "bottle_events" ("bottle_id") WHERE "type" = 'CREATED';

-- A bottle's identity never changes and a bottle is never deleted. Current-state columns (status)
-- stay updatable for future lifecycle events, always together with an event (ADR 0006).
CREATE FUNCTION bottles_identity_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."serial" IS DISTINCT FROM OLD."serial"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."public_token" IS DISTINCT FROM OLD."public_token"
     OR NEW."creation_batch_id" IS DISTINCT FROM OLD."creation_batch_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'AYVO: bottle identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "bottles_identity_immutable" BEFORE UPDATE ON "bottles"
  FOR EACH ROW EXECUTE FUNCTION bottles_identity_immutable();
CREATE TRIGGER "bottles_no_delete" BEFORE DELETE ON "bottles"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bottles_no_truncate" BEFORE TRUNCATE ON "bottles"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE TRIGGER "bottle_creation_batches_immutable" BEFORE UPDATE OR DELETE ON "bottle_creation_batches"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bottle_creation_batches_no_truncate" BEFORE TRUNCATE ON "bottle_creation_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Lifecycle history is append-only (ADR 0006).
CREATE TRIGGER "bottle_events_append_only" BEFORE UPDATE OR DELETE ON "bottle_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bottle_events_no_truncate" BEFORE TRUNCATE ON "bottle_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- label-production: print jobs -------------------------------------------------------------

ALTER TABLE "label_print_jobs"
  ADD CONSTRAINT "label_print_jobs_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "label_print_jobs_code_check" CHECK ("code" = ayvo_format_code('PJ-', "serial")),
  ADD CONSTRAINT "label_print_jobs_label_count_check" CHECK ("label_count" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "label_print_jobs_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "label_print_jobs_completed_check"
    CHECK ("status" <> 'COMPLETED'
       OR ("completed_at" IS NOT NULL AND "file_storage_key" IS NOT NULL
           AND "file_byte_size" > 0 AND "file_sha256" IS NOT NULL)),
  ADD CONSTRAINT "label_print_jobs_failed_check"
    CHECK ("status" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL)),
  -- DEV/production QR separation (ADR 0014): production jobs encode exactly the production QR
  -- host; no other environment may ever encode it. Same rule as the application guard.
  ADD CONSTRAINT "label_print_jobs_qr_environment_check"
    CHECK (CASE WHEN "app_environment" = 'production'
                THEN "public_base_url" = 'https://qr.ayvo.co'
                ELSE lower("public_base_url") NOT LIKE '%://qr.ayvo.co%' END);

ALTER TABLE "label_print_job_items"
  ADD CONSTRAINT "label_print_job_items_position_check" CHECK ("position" >= 0);

-- The job's identity (which bottles, which template version, which QR base URL) never changes;
-- only its processing state (status, attempts, timestamps, file, failure) does.
CREATE FUNCTION label_print_jobs_identity_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."serial" IS DISTINCT FROM OLD."serial"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."creation_batch_id" IS DISTINCT FROM OLD."creation_batch_id"
     OR NEW."label_template_version_id" IS DISTINCT FROM OLD."label_template_version_id"
     OR NEW."label_count" IS DISTINCT FROM OLD."label_count"
     OR NEW."public_base_url" IS DISTINCT FROM OLD."public_base_url"
     OR NEW."app_environment" IS DISTINCT FROM OLD."app_environment"
     OR NEW."qr_error_correction" IS DISTINCT FROM OLD."qr_error_correction"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'AYVO: print job identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "label_print_jobs_identity_immutable" BEFORE UPDATE ON "label_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION label_print_jobs_identity_immutable();
CREATE TRIGGER "label_print_jobs_no_delete" BEFORE DELETE ON "label_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "label_print_job_items_immutable" BEFORE UPDATE OR DELETE ON "label_print_job_items"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();

-- Each label's QR URL is exactly the job's base URL + "/" + the bottle's public token.
CREATE FUNCTION label_print_job_items_qr_url() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  expected text;
BEGIN
  SELECT j."public_base_url" || '/' || b."public_token" INTO expected
    FROM "label_print_jobs" j, "bottles" b
   WHERE j."id" = NEW."print_job_id" AND b."id" = NEW."bottle_id";
  IF expected IS DISTINCT FROM NEW."qr_url" THEN
    RAISE EXCEPTION 'AYVO: print job item QR URL does not match base URL and bottle token'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "label_print_job_items_qr_url" BEFORE INSERT ON "label_print_job_items"
  FOR EACH ROW EXECUTE FUNCTION label_print_job_items_qr_url();
