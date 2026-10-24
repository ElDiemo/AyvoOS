-- Finance — export for the accountant (doc 039 §7, N2). Additive: two append-only tables, a code
-- counter and one permission for ADMIN. An export is a fixed package (ZIP: CSV manifest + the
-- originals) for a period of issue dates; its content list is recorded per document version, so
-- what was handed over — and what was added or changed later — stays provable. Nothing is deleted.

INSERT INTO "code_counters" ("name", "last_value") VALUES ('accounting_export', 0);

CREATE TABLE "accounting_exports" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^AE-[0-9]{6,}$'),
  "period_from" date NOT NULL,
  "period_to" date NOT NULL,
  -- FULL: every valid document of the period; SUPPLEMENT: only what is new, changed or voided
  -- since the earlier exports of overlapping periods.
  "mode" text NOT NULL CHECK ("mode" IN ('FULL', 'SUPPLEMENT')),
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  "document_count" integer NOT NULL CHECK ("document_count" >= 0),
  "storage_key" text NOT NULL UNIQUE,
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "byte_size" integer NOT NULL CHECK ("byte_size" > 0),
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "request_id" uuid NOT NULL UNIQUE,
  CHECK ("period_to" >= "period_from"),
  CHECK ("period_to" - "period_from" <= 366)
);
CREATE INDEX "accounting_exports_period_idx" ON "accounting_exports" ("period_from", "period_to");

CREATE TABLE "accounting_export_items" (
  "export_id" uuid NOT NULL REFERENCES "accounting_exports"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "finance_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The document version handed over (its metadata as of that version, its unchanged file).
  "document_version" integer NOT NULL CHECK ("document_version" > 0),
  -- NEW: first handed over; CHANGED: its metadata changed since an earlier export; VOIDED: voided
  -- since an earlier export (listed, without the file); INCLUDED: part of a FULL export again.
  "change" text NOT NULL CHECK ("change" IN ('NEW', 'CHANGED', 'VOIDED', 'INCLUDED')),
  PRIMARY KEY ("export_id", "document_id"),
  FOREIGN KEY ("document_id", "document_version") REFERENCES "finance_document_events"("document_id", "version") ON DELETE RESTRICT
);
CREATE INDEX "accounting_export_items_document_idx" ON "accounting_export_items" ("document_id", "document_version");

CREATE TRIGGER "accounting_exports_append_only" BEFORE UPDATE OR DELETE ON "accounting_exports"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "accounting_exports_no_truncate" BEFORE TRUNCATE ON "accounting_exports"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "accounting_export_items_append_only" BEFORE UPDATE OR DELETE ON "accounting_export_items"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "accounting_export_items_no_truncate" BEFORE TRUNCATE ON "accounting_export_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('finance:exports_manage', 'Finance: create the period export for the accountant (ZIP with a CSV manifest and the originals); history and downloads need finance:documents_read', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'finance:exports_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
