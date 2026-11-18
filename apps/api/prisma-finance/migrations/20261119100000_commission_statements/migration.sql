-- Sales commissions PR 2b — the Finance commission closing: approved statements, their items and
-- events (doc 069 §5; owner approved doc 069 §3–§6 and O1–O16 for the first DEV version on
-- 2026-11-18). This PR only previews (reads); nothing writes these tables before PR 2c. The
-- invariants are here already, so the approval code can never weaken them:
--   * one statement per salesperson × month × currency × mode; strictly in order (§5a) — each
--     statement names the salesperson's latest one, and two statements can never name the same;
--   * the balance (§5c): opening = the previous statement's carried balance (≤ 0); closing =
--     opening + total; amount to invoice = max(0, closing); carried = min(0, closing);
--     total = the sum of the items;
--   * I1: one REGULAR item per invoice line and mode; one storno per original item:
--     UNIQUE (invoice_id, line_no, mode, salesperson_id, cause) (§5b);
--   * a LIVE statement never holds a line of a TEST invoice (no live kind exists yet, O1);
--   * append-only, also for the schema owner (ADR 0006).
-- No FK to the core: the salesperson is an id plus a name snapshot (ADR 0039).
--
-- Atomic by an explicit transaction (Prisma does not roll a failed file back by itself).

BEGIN;

CREATE TABLE "finance"."commission_statements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "period_month" DATE NOT NULL,
    "salesperson_id" UUID NOT NULL,
    "salesperson_name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "previous_statement_id" UUID,
    "opening_balance" DECIMAL(19,2) NOT NULL,
    "total" DECIMAL(19,2) NOT NULL,
    "closing_balance" DECIMAL(19,2) NOT NULL,
    "amount_to_invoice" DECIMAL(19,2) NOT NULL,
    "carried_forward" DECIMAL(19,2) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "sources_read_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "approved_by" UUID NOT NULL,
    "approved_by_name" TEXT NOT NULL,
    "request_id" UUID NOT NULL,

    CONSTRAINT "commission_statements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_statements_month_check" CHECK (date_trunc('month', "period_month") = "period_month"),
    CONSTRAINT "commission_statements_mode_check" CHECK ("mode" IN ('TEST', 'LIVE')),
    CONSTRAINT "commission_statements_name_check" CHECK (btrim("salesperson_name") <> ''),
    CONSTRAINT "commission_statements_balance_check" CHECK (
      "opening_balance" <= 0
      AND "closing_balance" = "opening_balance" + "total"
      AND "amount_to_invoice" = GREATEST(0, "closing_balance")
      AND "carried_forward" = LEAST(0, "closing_balance")
    ),
    CONSTRAINT "commission_statements_first_check" CHECK ("previous_statement_id" IS NOT NULL OR "opening_balance" = 0)
);
CREATE UNIQUE INDEX "commission_statements_request_id_key" ON "finance"."commission_statements"("request_id");
CREATE UNIQUE INDEX "commission_statements_slot_key"
  ON "finance"."commission_statements"("period_month", "salesperson_id", "currency", "mode");
-- The chain (§5a): a statement follows exactly one previous statement, and the first one is one.
CREATE UNIQUE INDEX "commission_statements_previous_key"
  ON "finance"."commission_statements"("previous_statement_id");
CREATE UNIQUE INDEX "commission_statements_first_key"
  ON "finance"."commission_statements"("salesperson_id", "currency", "mode") WHERE "previous_statement_id" IS NULL;
ALTER TABLE "finance"."commission_statements" ADD CONSTRAINT "commission_statements_previous_fkey"
  FOREIGN KEY ("previous_statement_id") REFERENCES "finance"."commission_statements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "finance"."commission_statement_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "statement_id" UUID NOT NULL,
    "item_no" INTEGER NOT NULL,
    -- Copies of the statement's, so the uniqueness below can name them (checked by the trigger).
    "mode" TEXT NOT NULL,
    "salesperson_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "service_month" DATE NOT NULL,
    "hotel_id" UUID NOT NULL,
    "hotel_code" TEXT NOT NULL,
    "base" DECIMAL(19,2) NOT NULL,
    "attribution_revision" INTEGER NOT NULL,
    "binding_id" UUID NOT NULL,
    "terms_version" INTEGER NOT NULL,
    "k" INTEGER NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,

    CONSTRAINT "commission_statement_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_statement_items_no_check" CHECK ("item_no" >= 1),
    CONSTRAINT "commission_statement_items_kind_check" CHECK (
      ("kind" = 'REGULAR' AND "cause" = 'REGULAR' AND "k" >= 1)
      OR ("kind" = 'CORRECTION' AND ("cause" = 'CANCELLED' OR "cause" ~ '^REATTRIBUTED:[1-9][0-9]*$'))
    ),
    CONSTRAINT "commission_statement_items_rate_check" CHECK ("rate" >= 0 AND "rate" <= 100),
    CONSTRAINT "commission_statement_items_revision_check" CHECK ("attribution_revision" >= 1 AND "terms_version" >= 1)
);
CREATE UNIQUE INDEX "commission_statement_items_no_key"
  ON "finance"."commission_statement_items"("statement_id", "item_no");
-- I1: one REGULAR item per source line and mode.
CREATE UNIQUE INDEX "commission_statement_items_regular_key"
  ON "finance"."commission_statement_items"("invoice_id", "line_no", "mode") WHERE "kind" = 'REGULAR';
-- §5b: one storno (and one correction per attribution revision) per original item.
CREATE UNIQUE INDEX "commission_statement_items_cause_key"
  ON "finance"."commission_statement_items"("invoice_id", "line_no", "mode", "salesperson_id", "cause");
CREATE INDEX "commission_statement_items_salesperson_idx"
  ON "finance"."commission_statement_items"("salesperson_id", "mode");
ALTER TABLE "finance"."commission_statement_items" ADD CONSTRAINT "commission_statement_items_statement_fkey"
  FOREIGN KEY ("statement_id") REFERENCES "finance"."commission_statements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance"."commission_statement_items" ADD CONSTRAINT "commission_statement_items_line_fkey"
  FOREIGN KEY ("invoice_id", "line_no") REFERENCES "finance"."invoice_lines"("invoice_id", "line_no") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "finance"."commission_statement_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "statement_id" UUID NOT NULL,
    -- PR 2d adds SALESPERSON_INVOICE_RECORDED and PAYOUT_PLANNED.
    "kind" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "recorded_by_name" TEXT NOT NULL,

    CONSTRAINT "commission_statement_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_statement_events_kind_check" CHECK ("kind" IN ('APPROVED'))
);
CREATE UNIQUE INDEX "commission_statement_events_one_approval"
  ON "finance"."commission_statement_events"("statement_id") WHERE "kind" = 'APPROVED';
ALTER TABLE "finance"."commission_statement_events" ADD CONSTRAINT "commission_statement_events_statement_fkey"
  FOREIGN KEY ("statement_id") REFERENCES "finance"."commission_statements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- --- The order and the balance chain (§5a, §5c) -----------------------------------------------

CREATE FUNCTION "finance"."commission_statements_insert"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  latest RECORD;
BEGIN
  SELECT "id", "period_month", "carried_forward" INTO latest
    FROM "finance"."commission_statements"
   WHERE "salesperson_id" = NEW."salesperson_id" AND "currency" = NEW."currency" AND "mode" = NEW."mode"
   ORDER BY "period_month" DESC LIMIT 1;
  IF latest."id" IS NULL THEN
    IF NEW."previous_statement_id" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: the first commission statement of a salesperson names no previous one'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."previous_statement_id" IS DISTINCT FROM latest."id" THEN
      RAISE EXCEPTION 'AYVO: a commission statement follows the salesperson''s latest statement'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."period_month" <= latest."period_month" THEN
      RAISE EXCEPTION 'AYVO: a commission statement is never at or before the salesperson''s latest one'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."opening_balance" <> latest."carried_forward" THEN
      RAISE EXCEPTION 'AYVO: the opening balance is the previous statement''s carried balance'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "commission_statements_insert" BEFORE INSERT ON "finance"."commission_statements"
  FOR EACH ROW EXECUTE FUNCTION "finance"."commission_statements_insert"();

-- --- Items belong to their statement and to a real line (I1, O1, §5b) --------------------------

CREATE FUNCTION "finance"."commission_statement_items_insert"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st RECORD;
  ln RECORD;
BEGIN
  SELECT "mode", "salesperson_id", "currency" INTO st
    FROM "finance"."commission_statements" WHERE "id" = NEW."statement_id";
  IF NEW."mode" IS DISTINCT FROM st."mode" OR NEW."salesperson_id" IS DISTINCT FROM st."salesperson_id" THEN
    RAISE EXCEPTION 'AYVO: a commission item has its statement''s mode and salesperson'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."kind", i."number", i."currency", l."period_month", l."hotel_id", l."amount",
         EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c WHERE c."invoice_id" = i."id") AS cancelled
    INTO ln
    FROM "finance"."invoice_lines" l JOIN "finance"."invoices" i ON i."id" = l."invoice_id"
   WHERE l."invoice_id" = NEW."invoice_id" AND l."line_no" = NEW."line_no";
  -- O1: TEST only into TEST; LIVE accepts only listed live kinds — none exist, so nothing yet.
  IF NOT (st."mode" = 'TEST' AND ln."kind" = 'TEST') THEN
    RAISE EXCEPTION 'AYVO: a % commission statement never holds a line of a % invoice', st."mode", ln."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ln."currency" <> st."currency" OR NEW."service_month" <> ln."period_month"
     OR NEW."hotel_id" <> ln."hotel_id" OR NEW."invoice_number" <> ln."number" THEN
    RAISE EXCEPTION 'AYVO: a commission item copies its invoice line'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'REGULAR' AND (ln."cancelled" OR NEW."base" <> ln."amount") THEN
    RAISE EXCEPTION 'AYVO: a regular commission item is a valid line at its full amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cause" = 'CANCELLED' AND NOT ln."cancelled" THEN
    RAISE EXCEPTION 'AYVO: a storno item needs a cancelled invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "commission_statement_items_insert" BEFORE INSERT ON "finance"."commission_statement_items"
  FOR EACH ROW EXECUTE FUNCTION "finance"."commission_statement_items_insert"();

-- At commit: the statement's total is the sum of its items, and it has at least one.
CREATE FUNCTION "finance"."assert_commission_statement_total"(sid UUID) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  t DECIMAL(19,2);
  n INTEGER;
  s DECIMAL(19,2);
BEGIN
  SELECT "total" INTO t FROM "finance"."commission_statements" WHERE "id" = sid;
  SELECT count(*), coalesce(sum("amount"), 0) INTO n, s
    FROM "finance"."commission_statement_items" WHERE "statement_id" = sid;
  IF n = 0 OR s <> t THEN
    RAISE EXCEPTION 'AYVO: a commission statement''s total is the sum of its items (% items, % ≠ %)', n, s, t
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
CREATE FUNCTION "finance"."commission_statements_complete"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM "finance"."assert_commission_statement_total"(NEW."id");
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "commission_statements_complete" AFTER INSERT ON "finance"."commission_statements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."commission_statements_complete"();
CREATE FUNCTION "finance"."commission_statement_items_complete"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM "finance"."assert_commission_statement_total"(NEW."statement_id");
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "commission_statement_items_complete" AFTER INSERT ON "finance"."commission_statement_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."commission_statement_items_complete"();

-- --- Append-only, also for the schema owner -----------------------------------------------------

CREATE TRIGGER "commission_statements_append_only" BEFORE UPDATE OR DELETE ON "finance"."commission_statements"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_statements_no_truncate" BEFORE TRUNCATE ON "finance"."commission_statements"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_statement_items_append_only" BEFORE UPDATE OR DELETE ON "finance"."commission_statement_items"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_statement_items_no_truncate" BEFORE TRUNCATE ON "finance"."commission_statement_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_statement_events_append_only" BEFORE UPDATE OR DELETE ON "finance"."commission_statement_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_statement_events_no_truncate" BEFORE TRUNCATE ON "finance"."commission_statement_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."commission_statements", "finance"."commission_statement_items",
  "finance"."commission_statement_events" TO "ayvo_finance_rw";

COMMIT;
