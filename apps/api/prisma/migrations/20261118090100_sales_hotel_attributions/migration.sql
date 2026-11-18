-- Sales commissions PR 1b — who gets the commission for a hotel, and the terms applied to it
-- (doc 068 §3.2–§3.3, ADR 0046 §2a). Owner, 2026-11-18: attribute a hotel to a salesperson, keep
-- the chosen terms version, the portfolio. After a signed contract the first paid month is
-- prefilled and the admin confirms it (another month with a reason); an existing hotel without
-- an acquisition is attributed by hand. No amounts, no Finance, no payment state.
--
-- No permission is added: attribution uses the existing `sales:manage` + `hotels:read`, the
-- portfolio `sales:work` (own) — doc 068 Q5. Additive: no existing table, trigger or constraint
-- changes. Atomic by an explicit transaction, as 20261117090100 (Prisma does not roll this file
-- back by itself; test/commission-attribution-migration).
--
-- Not in this migration (later, each with the owner's decision): the explicit future-only change
-- of a hotel's terms (EXPLICIT_CHANGE, doc 068 §3.3, Q11), statements and every amount (PR 2/3).

BEGIN;

-- --- Attribution revisions ---------------------------------------------------------------------

CREATE TABLE "sales_hotel_attributions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "hotel_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    -- In force from this service month (the 1st). For month M the row with the largest revision
    -- among effective_from <= M decides (doc 068 §3.2, Q6).
    "effective_from" DATE NOT NULL,
    -- NULL = explicitly nobody from that month (a house account), never "unknown".
    "salesperson_id" UUID,
    "source" TEXT NOT NULL,
    "contract_draft_id" UUID,
    "contract_revision" INTEGER,
    "prospect_id" UUID,
    -- Who was offered (the prospect's owner at the time): "confirmed as offered" vs "changed".
    "prefilled_salesperson_id" UUID,
    -- The 1st of the first paid month, confirmed explicitly by the admin; never moves (trigger).
    "commission_start" DATE NOT NULL,
    -- The signed revision's start_on as offered (exactly with CONTRACT), so a confirmed start in
    -- another month stays visible next to its reason.
    "contract_start_on" DATE,
    "reason" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "request_id" UUID NOT NULL,

    CONSTRAINT "sales_hotel_attributions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_hotel_attributions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "sales_hotel_attributions_effective_from_check"
      CHECK (EXTRACT(DAY FROM "effective_from") = 1),
    CONSTRAINT "sales_hotel_attributions_commission_start_check"
      CHECK (EXTRACT(DAY FROM "commission_start") = 1),
    CONSTRAINT "sales_hotel_attributions_source_check" CHECK ("source" IN ('CONTRACT', 'MANUAL')),
    CONSTRAINT "sales_hotel_attributions_contract_check" CHECK (
      ("source" = 'CONTRACT') = ("contract_draft_id" IS NOT NULL AND "contract_revision" IS NOT NULL
                                 AND "contract_start_on" IS NOT NULL)
      AND ("source" = 'CONTRACT' OR ("contract_draft_id" IS NULL AND "contract_revision" IS NULL
                                     AND "contract_start_on" IS NULL AND "prospect_id" IS NULL
                                     AND "prefilled_salesperson_id" IS NULL))),
    CONSTRAINT "sales_hotel_attributions_reason_check" CHECK (btrim("reason") <> '')
);

CREATE UNIQUE INDEX "sales_hotel_attributions_hotel_revision_key"
  ON "sales_hotel_attributions"("hotel_id", "revision");
CREATE UNIQUE INDEX "sales_hotel_attributions_request_id_key"
  ON "sales_hotel_attributions"("request_id");
CREATE INDEX "sales_hotel_attributions_salesperson_idx"
  ON "sales_hotel_attributions"("salesperson_id");

ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_hotel_id_fkey"
  FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_salesperson_id_fkey"
  FOREIGN KEY ("salesperson_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_prefilled_fkey"
  FOREIGN KEY ("prefilled_salesperson_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_recorded_by_fkey"
  FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_prospect_id_fkey"
  FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only a signed revision can be the source.
ALTER TABLE "sales_hotel_attributions" ADD CONSTRAINT "sales_hotel_attributions_contract_fkey"
  FOREIGN KEY ("contract_draft_id", "contract_revision")
  REFERENCES "contract_signed_documents"("draft_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Revisions follow each other per hotel; the first paid month is the first revision's for good;
-- a CONTRACT source is a signed draft of this very hotel (its hotel never changes once signed —
-- contract_drafts_signed_lock) and keeps that revision's start_on as offered.
CREATE FUNCTION sales_hotel_attributions_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  first_start DATE;
BEGIN
  IF NEW."revision" <> COALESCE((SELECT max("revision") FROM "sales_hotel_attributions"
                                  WHERE "hotel_id" = NEW."hotel_id"), 0) + 1 THEN
    RAISE EXCEPTION 'AYVO: attribution revisions follow each other' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."revision" > 1 THEN
    SELECT "commission_start" INTO first_start FROM "sales_hotel_attributions"
      WHERE "hotel_id" = NEW."hotel_id" AND "revision" = 1;
    IF NEW."commission_start" IS DISTINCT FROM first_start THEN
      RAISE EXCEPTION 'AYVO: the commission start of a hotel never moves' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."source" = 'CONTRACT' AND NOT EXISTS (
       SELECT 1 FROM "contract_drafts" d
       JOIN "contract_draft_revisions" r ON r."draft_id" = d."id" AND r."revision" = NEW."contract_revision"
       WHERE d."id" = NEW."contract_draft_id" AND d."hotel_id" = NEW."hotel_id"
         AND r."start_on" = NEW."contract_start_on"
         AND d."prospect_id" IS NOT DISTINCT FROM NEW."prospect_id") THEN
    RAISE EXCEPTION 'AYVO: the contract source is a signed draft of this hotel' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_hotel_attributions_insert" BEFORE INSERT ON "sales_hotel_attributions"
  FOR EACH ROW EXECUTE FUNCTION sales_hotel_attributions_insert();
-- History is append-only (ADR 0006): a change of salesperson is a new revision.
CREATE TRIGGER "sales_hotel_attributions_immutable" BEFORE UPDATE OR DELETE ON "sales_hotel_attributions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_hotel_attributions_no_truncate" BEFORE TRUNCATE ON "sales_hotel_attributions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- The terms applied to an attributed hotel (the snapshot) ----------------------------------

CREATE TABLE "sales_hotel_commission_terms" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "hotel_id" UUID NOT NULL,
    "attribution_revision" INTEGER NOT NULL,
    "binding_no" INTEGER NOT NULL,
    -- Only ON_ATTRIBUTION in PR 1b: written with the attribution from the salesperson's valid
    -- version. The explicit future-only change (EXPLICIT_CHANGE) comes with its own decision (Q11).
    "kind" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "terms_id" UUID NOT NULL,
    -- The snapshot: the rates used for this hotel, never re-read from the terms version.
    "initial_rate" NUMERIC NOT NULL,
    "initial_months" INTEGER NOT NULL,
    "maintenance_rate" NUMERIC NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "sales_hotel_commission_terms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_hotel_commission_terms_kind_check" CHECK ("kind" = 'ON_ATTRIBUTION' AND "binding_no" = 1),
    CONSTRAINT "sales_hotel_commission_terms_effective_from_check"
      CHECK (EXTRACT(DAY FROM "effective_from") = 1),
    CONSTRAINT "sales_hotel_commission_terms_initial_rate_check"
      CHECK ("initial_rate" >= 0 AND "initial_rate" <= 100 AND scale("initial_rate") <= 2),
    CONSTRAINT "sales_hotel_commission_terms_maintenance_rate_check"
      CHECK ("maintenance_rate" >= 0 AND "maintenance_rate" <= 100 AND scale("maintenance_rate") <= 2),
    CONSTRAINT "sales_hotel_commission_terms_initial_months_check" CHECK ("initial_months" >= 1)
);

CREATE UNIQUE INDEX "sales_hotel_commission_terms_binding_key"
  ON "sales_hotel_commission_terms"("hotel_id", "attribution_revision", "binding_no");
CREATE INDEX "sales_hotel_commission_terms_terms_id_idx" ON "sales_hotel_commission_terms"("terms_id");

ALTER TABLE "sales_hotel_commission_terms" ADD CONSTRAINT "sales_hotel_commission_terms_attribution_fkey"
  FOREIGN KEY ("hotel_id", "attribution_revision")
  REFERENCES "sales_hotel_attributions"("hotel_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_commission_terms" ADD CONSTRAINT "sales_hotel_commission_terms_terms_id_fkey"
  FOREIGN KEY ("terms_id") REFERENCES "sales_commission_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_hotel_commission_terms" ADD CONSTRAINT "sales_hotel_commission_terms_recorded_by_fkey"
  FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The binding belongs to its attribution's salesperson, from that attribution's month, and is an
-- exact copy of that salesperson's valid (newest) terms version when written.
CREATE FUNCTION sales_hotel_commission_terms_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  a RECORD;
  t RECORD;
BEGIN
  SELECT * INTO a FROM "sales_hotel_attributions"
    WHERE "hotel_id" = NEW."hotel_id" AND "revision" = NEW."attribution_revision";
  SELECT * INTO t FROM "sales_commission_terms" WHERE "id" = NEW."terms_id";
  IF a."salesperson_id" IS NULL OR t."salesperson_id" IS DISTINCT FROM a."salesperson_id"
     OR NEW."effective_from" <> a."effective_from"
     OR t."version" <> (SELECT max("version") FROM "sales_commission_terms"
                         WHERE "salesperson_id" = t."salesperson_id")
     OR NEW."initial_rate" <> t."initial_rate"
     OR NEW."initial_months" <> t."initial_months"
     OR NEW."maintenance_rate" <> t."maintenance_rate" THEN
    RAISE EXCEPTION 'AYVO: a binding is the snapshot of its salesperson''s valid terms'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_hotel_commission_terms_insert" BEFORE INSERT ON "sales_hotel_commission_terms"
  FOR EACH ROW EXECUTE FUNCTION sales_hotel_commission_terms_insert();
CREATE TRIGGER "sales_hotel_commission_terms_immutable" BEFORE UPDATE OR DELETE ON "sales_hotel_commission_terms"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_hotel_commission_terms_no_truncate" BEFORE TRUNCATE ON "sales_hotel_commission_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

COMMIT;
