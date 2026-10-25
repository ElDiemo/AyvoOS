-- Finance — received documents (doc 039, N1; ADR 0039). Runs as the owner of schema "finance"
-- (created by the Finance DB setup), which has no rights outside it: nothing here can touch the
-- core. The runtime role gets only SELECT / INSERT / UPDATE through the group "ayvo_finance_rw"
-- (no DELETE, no TRUNCATE, no DDL), so the Finance process cannot disable its own guards.

CREATE FUNCTION "finance"."reject_modification"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'AYVO: % on finance.% is not allowed (immutable record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TABLE "finance"."code_counters" (
  "name" text PRIMARY KEY,
  "last_value" bigint NOT NULL DEFAULT 0 CHECK ("last_value" >= 0)
);
INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('finance_document', 0);

CREATE TABLE "finance"."operation_requests" (
  "request_id" uuid PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER')),
  "payload_sha256" char(64) NOT NULL,
  "result" jsonb,
  "created_at" timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE "finance"."documents" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^FD-[0-9]{6,}$'),
  -- Metadata as written on the document; may be incomplete while it is being completed
  -- ("k doplnění"). Missing values stay NULL (never 0 or today).
  "supplier_id" uuid,
  "supplier_name" text,
  "kind" text NOT NULL CHECK ("kind" IN ('INVOICE', 'CREDIT_NOTE', 'ADVANCE_INVOICE', 'RECEIPT', 'OTHER')),
  "document_number" text CHECK ("document_number" IS NULL OR length(btrim("document_number")) BETWEEN 1 AND 100),
  "issued_on" date,
  "tax_point_on" date,
  "due_on" date,
  -- As written on the document (no VAT logic here); both or neither.
  "total_amount" numeric(19, 2),
  "currency" char(3) CHECK ("currency" ~ '^[A-Z]{3}$'),
  "description" text CHECK ("description" IS NULL OR length("description") <= 500),
  -- The month whose export the document belongs to (an organisational choice, not a tax date).
  "handover_month" date CHECK ("handover_month" IS NULL OR "handover_month" = date_trunc('month', "handover_month")::date),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'VOIDED')),
  "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0),
  -- The original: Finance's own upload (PDF, in Finance's storage) or a supplier document of the
  -- core, referenced without a copy (its bytes come through the core contract; its site is kept).
  "source" text NOT NULL CHECK ("source" IN ('UPLOAD', 'SUPPLIER_DOCUMENT')),
  "supplier_document_id" uuid,
  "source_site_id" uuid,
  "source_site_code" text,
  "storage_key" text UNIQUE,
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "byte_size" integer NOT NULL CHECK ("byte_size" > 0),
  "content_type" text NOT NULL CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  "original_filename" text NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_by" uuid NOT NULL,
  "created_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (("total_amount" IS NULL) = ("currency" IS NULL)),
  CHECK (("supplier_id" IS NULL) = ("supplier_name" IS NULL)),
  CHECK (
    ("source" = 'UPLOAD' AND "storage_key" IS NOT NULL AND "supplier_document_id" IS NULL
      AND "source_site_id" IS NULL AND "source_site_code" IS NULL AND "content_type" = 'application/pdf')
    OR ("source" = 'SUPPLIER_DOCUMENT' AND "storage_key" IS NULL AND "supplier_document_id" IS NOT NULL
      AND "source_site_id" IS NOT NULL AND "source_site_code" IS NOT NULL)
  )
);
CREATE INDEX "documents_issued_on_idx" ON "finance"."documents" ("issued_on");
CREATE INDEX "documents_supplier_id_idx" ON "finance"."documents" ("supplier_id");
CREATE INDEX "documents_handover_month_idx" ON "finance"."documents" ("handover_month");
CREATE INDEX "documents_supplier_document_id_idx" ON "finance"."documents" ("supplier_document_id");
-- The same file is received once while it is valid (a voided copy may be uploaded again), and
-- one supplier document becomes at most one valid finance document (one cost, however many
-- receipts it covers).
CREATE UNIQUE INDEX "documents_active_sha256" ON "finance"."documents" ("sha256") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "documents_active_supplier_document" ON "finance"."documents" ("supplier_document_id")
  WHERE "status" = 'ACTIVE' AND "supplier_document_id" IS NOT NULL;

-- History, append-only: what was received, every correction (full snapshot) and the voiding.
CREATE TABLE "finance"."document_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "document_id" uuid NOT NULL REFERENCES "finance"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" integer NOT NULL CHECK ("version" > 0),
  "type" text NOT NULL CHECK ("type" IN ('RECEIVED', 'CORRECTED', 'VOIDED')),
  "snapshot" jsonb NOT NULL,
  "reason" text CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 500),
  "actor_id" uuid NOT NULL,
  "actor_name" text NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "document_events_document_id_version_key" UNIQUE ("document_id", "version"),
  CHECK (("type" = 'RECEIVED') = ("reason" IS NULL))
);
CREATE TRIGGER "document_events_append_only" BEFORE UPDATE OR DELETE ON "finance"."document_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "document_events_no_truncate" BEFORE TRUNCATE ON "finance"."document_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- The current state changes only with the next version; the file, source and identity never; a
-- voided document stays voided; a document is never deleted.
CREATE FUNCTION "finance"."documents_guard"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: finance documents are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."serial" <> OLD."serial" OR NEW."code" <> OLD."code"
     OR NEW."sha256" <> OLD."sha256" OR NEW."byte_size" <> OLD."byte_size"
     OR NEW."content_type" <> OLD."content_type" OR NEW."original_filename" <> OLD."original_filename"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" <> OLD."created_by"
     OR NEW."created_by_name" <> OLD."created_by_name" OR NEW."request_id" <> OLD."request_id"
     OR NEW."source" <> OLD."source"
     OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."supplier_document_id" IS DISTINCT FROM OLD."supplier_document_id"
     OR NEW."source_site_id" IS DISTINCT FROM OLD."source_site_id"
     OR NEW."source_site_code" IS DISTINCT FROM OLD."source_site_code" THEN
    RAISE EXCEPTION 'AYVO: the original file and identity of a finance document are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'VOIDED' THEN
    RAISE EXCEPTION 'AYVO: a voided finance document cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'AYVO: a finance document changes only with the next version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documents_guard" BEFORE UPDATE OR DELETE ON "finance"."documents"
  FOR EACH ROW EXECUTE FUNCTION "finance"."documents_guard"();
CREATE TRIGGER "documents_no_truncate" BEFORE TRUNCATE ON "finance"."documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- Every version of the current state has its event (checked at commit).
CREATE FUNCTION "finance"."documents_have_event"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "finance"."document_events" e
                 WHERE e."document_id" = NEW."id" AND e."version" = NEW."version") THEN
    RAISE EXCEPTION 'AYVO: finance document % version % has no event', NEW."code", NEW."version"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "documents_have_event" AFTER INSERT OR UPDATE ON "finance"."documents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."documents_have_event"();

-- The runtime role (member of ayvo_finance_rw): reads and writes rows, never deletes; counters and
-- idempotency rows are updated in place by design.
GRANT USAGE ON SCHEMA "finance" TO "ayvo_finance_rw";
GRANT SELECT, INSERT, UPDATE ON "finance"."code_counters", "finance"."operation_requests",
  "finance"."documents", "finance"."document_events" TO "ayvo_finance_rw";
