-- Hotel portal, the operational boundary A2 (v6, #148 comments 6773883145 and 6773928715; review
-- 5858166766): every change of an agreement's terms is a numbered terms revision of that agreement.
-- A change that takes the hotel from its payer (another payer, or an earlier end of the terms) is
-- a TRANSFER: reserved first, then the core's fence for the leaving payer, then committed — so the
-- old payer's portal operations end before the change exists. A RESTORE gives a fenced payer its
-- operations back: committed in Finance, naming the fences, and only from it is the core's
-- resolution built.

-- The idempotency kind of a restore (a change of terms keeps BILLING_AGREEMENT_VERSION).
ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT', 'INVOICE_TEST_ISSUE', 'INVOICE_TEST_CANCEL', 'INVOICE_TEST_RUN',
                    'PAYMENTS_SIMULATE', 'PAYMENTS_IMPORT_BANK', 'PAYMENT_ALLOCATE',
                    'INVOICE_DELIVERY_REQUEST', 'INVOICE_DELIVERY_RETRY',
                    'BILLING_RUN_SETTINGS_VERSION', 'BILLING_TERMS_RESTORE'));

-- --- Revisions (append-only) --------------------------------------------------------------------

CREATE TABLE "finance"."billing_terms_revisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "agreement_id" UUID NOT NULL,
    -- The order of the agreement's terms: 1, 2, … (the backfilled versions keep theirs).
    "revision" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    -- CHANGE: the version's payer; TRANSFER: the leaving payer; RESTORE: the payer restored.
    "payer_customer_id" UUID NOT NULL,
    -- TRANSFER: the agreement version the form was edited from and the terms to commit.
    "base_revision" BIGINT,
    "terms" JSONB,
    -- TRANSFER: the leaving payer's last day of operations.
    "fence_ends_on" DATE,
    -- RESTORE: the fences (core ids, from this agreement's transfers of the payer) it resolves.
    "resolves_fence_ids" UUID[] NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "recorded_by_name" TEXT NOT NULL,

    CONSTRAINT "billing_terms_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_terms_revisions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "billing_terms_revisions_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "billing_terms_revisions_intent_check" CHECK (
      ("intent" = 'CHANGE' AND "terms" IS NULL AND "fence_ends_on" IS NULL
        AND cardinality("resolves_fence_ids") = 0)
      OR ("intent" = 'TRANSFER' AND "terms" IS NOT NULL AND "base_revision" IS NOT NULL
        AND "fence_ends_on" IS NOT NULL AND cardinality("resolves_fence_ids") = 0)
      OR ("intent" = 'RESTORE' AND "terms" IS NULL AND "base_revision" IS NULL
        AND "fence_ends_on" IS NULL AND cardinality("resolves_fence_ids") BETWEEN 1 AND 100)
    )
);
CREATE UNIQUE INDEX "billing_terms_revisions_request_id_key" ON "finance"."billing_terms_revisions"("request_id");
CREATE UNIQUE INDEX "billing_terms_revisions_agreement_id_revision_key"
  ON "finance"."billing_terms_revisions"("agreement_id", "revision");
ALTER TABLE "finance"."billing_terms_revisions" ADD CONSTRAINT "billing_terms_revisions_agreement_id_fkey"
  FOREIGN KEY ("agreement_id") REFERENCES "finance"."billing_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."billing_terms_revisions" ADD CONSTRAINT "billing_terms_revisions_payer_customer_id_fkey"
  FOREIGN KEY ("payer_customer_id") REFERENCES "finance"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Their events (append-only): FENCED, COMMITTED, ABANDONED, RESOLVED_SENT ----------------------

CREATE TABLE "finance"."billing_terms_revision_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "revision_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    -- FENCED: the core's fence id (also known when the change was then abandoned).
    "fence_id" UUID,
    -- COMMITTED of a CHANGE or TRANSFER: the agreement version written.
    "agreement_version_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "recorded_by_name" TEXT NOT NULL,

    CONSTRAINT "billing_terms_revision_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_terms_revision_events_kind_check" CHECK (
      ("kind" = 'FENCED' AND "fence_id" IS NOT NULL AND "agreement_version_id" IS NULL)
      OR ("kind" = 'COMMITTED' AND "fence_id" IS NULL)
      OR ("kind" IN ('ABANDONED', 'RESOLVED_SENT') AND "fence_id" IS NULL AND "agreement_version_id" IS NULL)
    )
);
-- Each event at most once per revision.
CREATE UNIQUE INDEX "billing_terms_revision_events_revision_id_kind_key"
  ON "finance"."billing_terms_revision_events"("revision_id", "kind");
ALTER TABLE "finance"."billing_terms_revision_events" ADD CONSTRAINT "billing_terms_revision_events_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "finance"."billing_terms_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."billing_terms_revision_events" ADD CONSTRAINT "billing_terms_revision_events_agreement_version_id_fkey"
  FOREIGN KEY ("agreement_version_id") REFERENCES "finance"."agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The order of a revision's life, also for a direct write: settled once (COMMITTED xor ABANDONED);
-- FENCED only on an unsettled TRANSFER; a TRANSFER commits only fenced, with its version; CHANGE
-- commits with its version; RESTORE commits without one and only it is ever sent to the core.
CREATE FUNCTION "finance"."billing_terms_revision_events_rules"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  intent TEXT;
  settled BOOLEAN;
  fenced BOOLEAN;
BEGIN
  SELECT r."intent" INTO intent FROM "finance"."billing_terms_revisions" r WHERE r."id" = NEW."revision_id";
  SELECT EXISTS (SELECT 1 FROM "finance"."billing_terms_revision_events" e
                 WHERE e."revision_id" = NEW."revision_id" AND e."kind" IN ('COMMITTED', 'ABANDONED'))
    INTO settled;
  SELECT EXISTS (SELECT 1 FROM "finance"."billing_terms_revision_events" e
                 WHERE e."revision_id" = NEW."revision_id" AND e."kind" = 'FENCED')
    INTO fenced;
  IF NEW."kind" IN ('COMMITTED', 'ABANDONED', 'FENCED') AND settled THEN
    RAISE EXCEPTION 'AYVO: a terms revision is settled once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FENCED' AND intent <> 'TRANSFER' THEN
    RAISE EXCEPTION 'AYVO: only a transfer is fenced' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'COMMITTED' AND (
       (intent = 'TRANSFER' AND (NOT fenced OR NEW."agreement_version_id" IS NULL))
    OR (intent = 'CHANGE' AND NEW."agreement_version_id" IS NULL)
    OR (intent = 'RESTORE' AND NEW."agreement_version_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'AYVO: a transfer commits only after its fence, with its version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ABANDONED' AND intent <> 'TRANSFER' THEN
    RAISE EXCEPTION 'AYVO: only a reserved transfer is abandoned' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RESOLVED_SENT' AND (intent <> 'RESTORE' OR NOT settled) THEN
    RAISE EXCEPTION 'AYVO: only a committed restore is sent to the core' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "billing_terms_revision_events_rules" BEFORE INSERT ON "finance"."billing_terms_revision_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."billing_terms_revision_events_rules"();

CREATE TRIGGER "billing_terms_revisions_append_only" BEFORE UPDATE OR DELETE ON "finance"."billing_terms_revisions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_terms_revisions_no_truncate" BEFORE TRUNCATE ON "finance"."billing_terms_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_terms_revision_events_append_only" BEFORE UPDATE OR DELETE ON "finance"."billing_terms_revision_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_terms_revision_events_no_truncate" BEFORE TRUNCATE ON "finance"."billing_terms_revision_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."billing_terms_revisions", "finance"."billing_terms_revision_events"
  TO "ayvo_finance_rw";

-- --- The terms revision of every agreement version ----------------------------------------------

-- Existing versions: their order in the agreement (by the commit-order revision), the same number
-- the A1 check already sends. No reservation is made for them. The append-only trigger is off only
-- for this one backfill, inside this migration's transaction.
ALTER TABLE "finance"."agreement_versions" ADD COLUMN "terms_revision" INTEGER;
ALTER TABLE "finance"."agreement_versions" DISABLE TRIGGER "agreement_versions_append_only";
UPDATE "finance"."agreement_versions" v SET "terms_revision" = o."n"
  FROM (SELECT "id", row_number() OVER (PARTITION BY "agreement_id" ORDER BY "revision") AS "n"
        FROM "finance"."agreement_versions") o
  WHERE o."id" = v."id";
ALTER TABLE "finance"."agreement_versions" ENABLE TRIGGER "agreement_versions_append_only";
-- No default: a version is written only with its revision — an older Finance image cannot write
-- terms at all (so never a change of payer without its fence).
ALTER TABLE "finance"."agreement_versions" ALTER COLUMN "terms_revision" SET NOT NULL;
CREATE UNIQUE INDEX "agreement_versions_agreement_id_terms_revision_key"
  ON "finance"."agreement_versions"("agreement_id", "terms_revision");
