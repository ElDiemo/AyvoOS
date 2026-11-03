-- Contract drafts — a manual generator (owner 2026-11-03, ADR 0043, doc 045). Additive: own tables
-- of the module `contracts`. A draft belongs to a prospect or a hotel (FKs keep the reference
-- valid; nothing is written there). Nothing here creates a hotel, touches billing (Finance),
-- sends or signs anything. The signed original is a later migration (doc 045 delivery 3).
-- ---------------------------------------------------------------------------------------------
-- 1. Drafts (current state; every change is a contract_draft_events row in the same transaction)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "contract_drafts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "prospect_id" UUID,
    "hotel_id" UUID,
    -- Optimistic lock: every change of the row is its next version.
    "version" INTEGER NOT NULL DEFAULT 1,
    -- The newest content revision (contract_draft_revisions).
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    -- Removed by hand (confirmed, with a reason); restorable, never deleted.
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    "remove_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "contract_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_drafts_serial_check" CHECK ("serial" >= 1),
    CONSTRAINT "contract_drafts_code_check" CHECK ("code" = ayvo_format_code('SN-', "serial")),
    -- Always in a context: a prospect, a hotel, or both.
    CONSTRAINT "contract_drafts_context_check" CHECK ("prospect_id" IS NOT NULL OR "hotel_id" IS NOT NULL),
    CONSTRAINT "contract_drafts_version_check" CHECK ("version" >= 1 AND "current_revision" >= 1),
    CONSTRAINT "contract_drafts_removed_check" CHECK (
      ("removed_at" IS NULL) = ("removed_by" IS NULL) AND ("removed_at" IS NULL) = ("remove_reason" IS NULL)
      AND ("remove_reason" IS NULL OR (btrim("remove_reason") <> '' AND length("remove_reason") <= 500)))
);
CREATE UNIQUE INDEX "contract_drafts_serial_key" ON "contract_drafts"("serial");
CREATE UNIQUE INDEX "contract_drafts_code_key" ON "contract_drafts"("code");
CREATE INDEX "contract_drafts_prospect_id_idx" ON "contract_drafts"("prospect_id");
CREATE INDEX "contract_drafts_hotel_id_idx" ON "contract_drafts"("hotel_id");
ALTER TABLE "contract_drafts"
  ADD CONSTRAINT "contract_drafts_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_drafts_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_drafts_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_drafts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_drafts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
INSERT INTO "code_counters" ("name", "last_value") VALUES ('contract_draft', 0);

-- Never deleted; identity and context fixed; each change is the next version; a removed draft
-- takes nothing but its restore; the prospect never changes (a hotel is linked, never unlinked).
CREATE FUNCTION contract_drafts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: contract drafts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."serial" <> OLD."serial" OR NEW."code" <> OLD."code"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" <> OLD."created_by"
     OR NEW."prospect_id" IS DISTINCT FROM OLD."prospect_id"
     OR (OLD."hotel_id" IS NOT NULL AND NEW."hotel_id" IS DISTINCT FROM OLD."hotel_id")
     OR NEW."version" <> OLD."version" + 1
     OR NEW."current_revision" < OLD."current_revision" THEN
    RAISE EXCEPTION 'AYVO: a contract draft changes only to its next version' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL AND NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a removed contract draft takes no change until restored' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL AND (NEW."current_revision" <> OLD."current_revision"
     OR NEW."hotel_id" IS DISTINCT FROM OLD."hotel_id") THEN
    RAISE EXCEPTION 'AYVO: restoring a contract draft changes nothing else' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "contract_drafts_guard" BEFORE UPDATE OR DELETE ON "contract_drafts"
  FOR EACH ROW EXECUTE FUNCTION contract_drafts_guard();
CREATE TRIGGER "contract_drafts_no_truncate" BEFORE TRUNCATE ON "contract_drafts"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 2. Revisions (append-only): the full content the PDF is rendered from, with its template
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "contract_draft_revisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "draft_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "template_version" TEXT NOT NULL,
    "counterparty_name" TEXT NOT NULL,
    "counterparty_company_id" TEXT,
    "counterparty_address" TEXT,
    "representative_name" TEXT,
    "representative_role" TEXT,
    "hotel_name" TEXT NOT NULL,
    "hotel_address" TEXT NOT NULL,
    "rooms" INTEGER NOT NULL,
    -- Without VAT; exact. No typmod: a third decimal is refused, never rounded.
    "price_per_room_month" NUMERIC NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "start_on" DATE NOT NULL,
    "billing_timing" TEXT NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "holders" TEXT NOT NULL,
    "holders_ownership" TEXT,
    -- Why it changed; null only for the first revision.
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    CONSTRAINT "contract_draft_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_draft_revisions_template_check" CHECK ("template_version" IN ('cs-b2b-1')),
    CONSTRAINT "contract_draft_revisions_text_check" CHECK (
      btrim("counterparty_name") <> '' AND length("counterparty_name") <= 200
      AND ("counterparty_company_id" IS NULL OR (btrim("counterparty_company_id") <> '' AND length("counterparty_company_id") <= 30))
      AND ("counterparty_address" IS NULL OR (btrim("counterparty_address") <> '' AND length("counterparty_address") <= 400))
      AND ("representative_name" IS NULL OR (btrim("representative_name") <> '' AND length("representative_name") <= 160))
      AND ("representative_role" IS NULL OR (btrim("representative_role") <> '' AND length("representative_role") <= 120))
      AND btrim("hotel_name") <> '' AND length("hotel_name") <= 200
      AND btrim("hotel_address") <> '' AND length("hotel_address") <= 400),
    CONSTRAINT "contract_draft_revisions_numbers_check" CHECK (
      "revision" >= 1 AND "rooms" BETWEEN 1 AND 100000
      AND "price_per_room_month" > 0 AND scale("price_per_room_month") <= 2
      AND "currency" ~ '^[A-Z]{3}$' AND "payment_terms_days" BETWEEN 0 AND 365),
    CONSTRAINT "contract_draft_revisions_timing_check" CHECK ("billing_timing" IN ('ADVANCE', 'ARREARS')),
    -- The ownership of holders is chosen exactly when there are holders.
    CONSTRAINT "contract_draft_revisions_holders_check" CHECK (
      "holders" IN ('NONE', 'WITH')
      AND ("holders_ownership" IS NULL OR "holders_ownership" IN ('AYVO', 'CUSTOMER'))
      AND ("holders" = 'WITH') = ("holders_ownership" IS NOT NULL)),
    CONSTRAINT "contract_draft_revisions_reason_check" CHECK (
      ("revision" = 1) = ("reason" IS NULL)
      AND ("reason" IS NULL OR (btrim("reason") <> '' AND length("reason") <= 500)))
);
CREATE UNIQUE INDEX "contract_draft_revisions_draft_id_revision_key" ON "contract_draft_revisions"("draft_id", "revision");
CREATE UNIQUE INDEX "contract_draft_revisions_request_id_key" ON "contract_draft_revisions"("request_id");
ALTER TABLE "contract_draft_revisions"
  ADD CONSTRAINT "contract_draft_revisions_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "contract_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_draft_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Revisions follow each other without gaps, and a removed draft takes none.
CREATE FUNCTION contract_draft_revisions_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."revision" <> COALESCE((SELECT max("revision") FROM "contract_draft_revisions"
                                  WHERE "draft_id" = NEW."draft_id"), 0) + 1 THEN
    RAISE EXCEPTION 'AYVO: contract draft revisions follow each other' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "contract_drafts" WHERE "id" = NEW."draft_id" AND "removed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a removed contract draft takes no revision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "contract_draft_revisions_insert" BEFORE INSERT ON "contract_draft_revisions"
  FOR EACH ROW EXECUTE FUNCTION contract_draft_revisions_insert();
CREATE TRIGGER "contract_draft_revisions_immutable" BEFORE UPDATE OR DELETE ON "contract_draft_revisions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "contract_draft_revisions_no_truncate" BEFORE TRUNCATE ON "contract_draft_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 3. Events (append-only audit: who did what, when, why)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "contract_draft_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "draft_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER,
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "details" JSONB,
    CONSTRAINT "contract_draft_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_draft_events_kind_check" CHECK ("kind" IN (
      'CREATED', 'REVISED', 'REMOVED', 'RESTORED', 'HOTEL_LINKED', 'PDF_DOWNLOADED',
      'SIGNED_UPLOADED', 'SIGNED_DOWNLOADED')),
    CONSTRAINT "contract_draft_events_reason_check" CHECK (
      "reason" IS NULL OR (btrim("reason") <> '' AND length("reason") <= 500))
);
CREATE INDEX "contract_draft_events_draft_id_at_idx" ON "contract_draft_events"("draft_id", "at");
ALTER TABLE "contract_draft_events"
  ADD CONSTRAINT "contract_draft_events_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "contract_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_draft_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "contract_draft_events_immutable" BEFORE UPDATE OR DELETE ON "contract_draft_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "contract_draft_events_no_truncate" BEFORE TRUNCATE ON "contract_draft_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
