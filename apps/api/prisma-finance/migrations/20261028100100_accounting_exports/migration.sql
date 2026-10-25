-- Finance — monthly export for the accountant (doc 039 §7, N2; ADR 0039). Runs as the owner of
-- schema "finance". An export is a fixed package (ZIP: CSV manifest + the originals) of one
-- handover month, recorded per document version with the file hash; what the person confirmed is
-- bound to the preview fingerprint. Generated, downloaded and handed over to the accountant are
-- separate, append-only events. Nothing is updated or deleted.

INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('accounting_export', 0);

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER'));

CREATE TABLE "finance"."exports" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^AE-[0-9]{6,}$'),
  -- The handover month (first day), as chosen on the documents — not a tax period.
  "handover_month" date NOT NULL CHECK ("handover_month" = date_trunc('month', "handover_month")::date),
  -- FULL: every complete valid document of the month; SUPPLEMENT: only what is new, changed or
  -- voided since the earlier exports of that month.
  "mode" text NOT NULL CHECK ("mode" IN ('FULL', 'SUPPLEMENT')),
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  -- The preview the person confirmed (every document id, version, change and file hash).
  "preview_fingerprint" char(64) NOT NULL CHECK ("preview_fingerprint" ~ '^[a-f0-9]{64}$'),
  "document_count" integer NOT NULL CHECK ("document_count" > 0),
  "storage_key" text NOT NULL UNIQUE,
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "byte_size" integer NOT NULL CHECK ("byte_size" > 0),
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_by" uuid NOT NULL,
  "created_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);
CREATE INDEX "exports_handover_month_idx" ON "finance"."exports" ("handover_month");

CREATE TABLE "finance"."export_items" (
  "export_id" uuid NOT NULL REFERENCES "finance"."exports"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "finance"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The document version handed over (its metadata as of that version) and its file's hash.
  "document_version" integer NOT NULL CHECK ("document_version" > 0),
  -- NEW: first in an export of the month; CHANGED: its metadata changed since; VOIDED: voided
  -- since (listed, without the file); INCLUDED: unchanged, again in a FULL export.
  "change" text NOT NULL CHECK ("change" IN ('NEW', 'CHANGED', 'VOIDED', 'INCLUDED')),
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY ("export_id", "document_id"),
  CONSTRAINT "export_items_document_id_document_version_fkey" FOREIGN KEY ("document_id", "document_version")
    REFERENCES "finance"."document_events"("document_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "export_items_document_id_document_version_idx" ON "finance"."export_items" ("document_id", "document_version");

CREATE TABLE "finance"."export_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "export_id" uuid NOT NULL REFERENCES "finance"."exports"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('GENERATED', 'DOWNLOADED', 'HANDED_OVER')),
  -- HANDED_OVER only: the day it was handed to the accountant (stated by the person).
  "handed_over_on" date,
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  "actor_id" uuid NOT NULL,
  "actor_name" text NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (("type" = 'HANDED_OVER') = ("handed_over_on" IS NOT NULL))
);
CREATE INDEX "export_events_export_id_idx" ON "finance"."export_events" ("export_id");
-- An export is handed over once (a mistake is a new export, never an edited record).
CREATE UNIQUE INDEX "export_events_one_handover" ON "finance"."export_events" ("export_id") WHERE "type" = 'HANDED_OVER';

CREATE TRIGGER "exports_append_only" BEFORE UPDATE OR DELETE ON "finance"."exports"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "exports_no_truncate" BEFORE TRUNCATE ON "finance"."exports"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "export_items_append_only" BEFORE UPDATE OR DELETE ON "finance"."export_items"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "export_items_no_truncate" BEFORE TRUNCATE ON "finance"."export_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "export_events_append_only" BEFORE UPDATE OR DELETE ON "finance"."export_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "export_events_no_truncate" BEFORE TRUNCATE ON "finance"."export_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- Every export has its GENERATED event (checked at commit).
CREATE FUNCTION "finance"."exports_have_generated"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "finance"."export_events" e
                 WHERE e."export_id" = NEW."id" AND e."type" = 'GENERATED') THEN
    RAISE EXCEPTION 'AYVO: export % has no GENERATED event', NEW."code" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "exports_have_generated" AFTER INSERT ON "finance"."exports"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."exports_have_generated"();

-- Runtime: append only (no UPDATE, no DELETE).
GRANT SELECT, INSERT ON "finance"."exports", "finance"."export_items", "finance"."export_events" TO "ayvo_finance_rw";
