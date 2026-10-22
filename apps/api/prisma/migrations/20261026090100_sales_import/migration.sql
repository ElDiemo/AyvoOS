-- Obchod — CSV import of prospects (doc 034 §13). Additive: the result record of a confirmed
-- import (append-only) and the link of each created prospect to it. The file itself is never
-- stored; a preview writes nothing.

CREATE TABLE "sales_imports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    -- The checksum of the confirmed file (the content is not kept).
    "file_sha256" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" UUID NOT NULL,
    -- The rows not imported: [{ "row": 7, "errors": ["COUNTRY_MISSING"] }] — row numbers and error
    -- codes only, never contact data.
    "skipped" JSONB NOT NULL,

    CONSTRAINT "sales_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_imports_serial_check" CHECK ("serial" >= 1),
    CONSTRAINT "sales_imports_code_check" CHECK ("code" = ayvo_format_code('IMP-', "serial")),
    CONSTRAINT "sales_imports_file_check" CHECK (
      btrim("file_name") <> '' AND length("file_name") <= 255 AND "file_sha256" ~ '^[0-9a-f]{64}$'
      AND "encoding" IN ('UTF-8', 'windows-1250') AND "delimiter" IN (',', ';')),
    CONSTRAINT "sales_imports_counts_check" CHECK (
      "row_count" >= 1 AND "created_count" >= 1 AND "created_count" <= "row_count"),
    CONSTRAINT "sales_imports_skipped_check" CHECK (jsonb_typeof("skipped") = 'array')
);
CREATE UNIQUE INDEX "sales_imports_serial_key" ON "sales_imports"("serial");
CREATE UNIQUE INDEX "sales_imports_code_key" ON "sales_imports"("code");
CREATE UNIQUE INDEX "sales_imports_request_id_key" ON "sales_imports"("request_id");
CREATE INDEX "sales_imports_created_by_created_at_idx" ON "sales_imports"("created_by", "created_at");
ALTER TABLE "sales_imports"
  ADD CONSTRAINT "sales_imports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_imports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "sales_imports_append_only" BEFORE UPDATE OR DELETE ON "sales_imports"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_imports_no_truncate" BEFORE TRUNCATE ON "sales_imports"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

INSERT INTO "code_counters" ("name", "last_value") VALUES ('sales_import', 0);

-- The import a prospect came from (set at creation, never changed).
ALTER TABLE "sales_prospects"
  ADD COLUMN "import_id" UUID,
  ADD COLUMN "import_row" INTEGER,
  ADD CONSTRAINT "sales_prospects_import_check" CHECK (("import_id" IS NULL) = ("import_row" IS NULL) AND ("import_row" IS NULL OR "import_row" >= 2)),
  ADD CONSTRAINT "sales_prospects_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "sales_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "sales_prospects_import_id_import_row_key" ON "sales_prospects"("import_id", "import_row");

CREATE FUNCTION sales_prospects_import_identity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."import_id" IS DISTINCT FROM OLD."import_id" OR NEW."import_row" IS DISTINCT FROM OLD."import_row" THEN
    RAISE EXCEPTION 'AYVO: the import of a prospect is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_prospects_import_identity" BEFORE UPDATE ON "sales_prospects"
  FOR EACH ROW EXECUTE FUNCTION sales_prospects_import_identity();
