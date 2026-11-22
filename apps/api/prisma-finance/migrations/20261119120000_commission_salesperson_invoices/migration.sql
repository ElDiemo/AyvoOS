-- Sales commissions PR 2d (doc 069 §5, §5d "Payout plan"; doc 068 C12, I3; owner OK GO
-- 2026-11-18 for DEV with synthetic TEST data): the salesperson's one invoice on an approved
-- statement and the planned payout day. Nothing is paid here: no payout, no payment order, no
-- accounting integration — "Vyplaceno" (doc 068 I4) is a later batch.
BEGIN;

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
                    'BILLING_RUN_SETTINGS_VERSION', 'BILLING_TERMS_RESTORE',
                    'COMMISSION_STATEMENT_APPROVE', 'COMMISSION_SALESPERSON_INVOICE'));

-- The payout rule (C12, O11): the 15th of the first month whose cut-off (the 10th) the actual
-- receipt met, never before the 15th of M+1. One place — the application computes the same and
-- the table refuses any other day.
CREATE FUNCTION "finance"."commission_payout_on"(period_month DATE, received_on DATE) RETURNS DATE
  LANGUAGE sql IMMUTABLE STRICT
  AS $$
    SELECT greatest(
      (date_trunc('month', received_on::timestamp)
        + CASE WHEN extract(day FROM received_on) <= 10 THEN interval '0' ELSE interval '1 month' END)::date + 14,
      (date_trunc('month', period_month::timestamp) + interval '1 month')::date + 14)
  $$;

CREATE TABLE "finance"."commission_salesperson_invoices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "statement_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "salesperson_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "received_on" DATE NOT NULL,
    -- The base without VAT = the statement's amount to invoice (I3).
    "base" DECIMAL(19,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payout_on" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "recorded_by_name" TEXT NOT NULL,
    "request_id" UUID NOT NULL,

    CONSTRAINT "commission_salesperson_invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_salesperson_invoices_number_check"
      CHECK ("invoice_number" = btrim("invoice_number") AND length("invoice_number") BETWEEN 1 AND 40),
    CONSTRAINT "commission_salesperson_invoices_dates_check" CHECK ("issued_on" <= "received_on"),
    CONSTRAINT "commission_salesperson_invoices_base_check" CHECK ("base" > 0),
    CONSTRAINT "commission_salesperson_invoices_payout_check" CHECK ("payout_on" >= "received_on")
);
-- One salesperson invoice per statement (I3); a number once per salesperson and mode.
CREATE UNIQUE INDEX "commission_salesperson_invoices_statement_key"
  ON "finance"."commission_salesperson_invoices"("statement_id");
CREATE UNIQUE INDEX "commission_salesperson_invoices_number_key"
  ON "finance"."commission_salesperson_invoices"("mode", "salesperson_id", "invoice_number");
CREATE UNIQUE INDEX "commission_salesperson_invoices_request_id_key"
  ON "finance"."commission_salesperson_invoices"("request_id");
ALTER TABLE "finance"."commission_salesperson_invoices" ADD CONSTRAINT "commission_salesperson_invoices_statement_fkey"
  FOREIGN KEY ("statement_id") REFERENCES "finance"."commission_statements"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "finance"."commission_salesperson_invoices_insert"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st RECORD;
BEGIN
  SELECT "mode", "salesperson_id", "currency", "period_month", "amount_to_invoice" INTO st
    FROM "finance"."commission_statements" WHERE "id" = NEW."statement_id";
  IF NEW."mode" IS DISTINCT FROM st."mode" OR NEW."salesperson_id" IS DISTINCT FROM st."salesperson_id" THEN
    RAISE EXCEPTION 'AYVO: a salesperson invoice has its statement''s mode and salesperson'
      USING ERRCODE = 'check_violation';
  END IF;
  IF st."amount_to_invoice" <= 0 THEN
    RAISE EXCEPTION 'AYVO: a statement with nothing to invoice takes no salesperson invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."base" <> st."amount_to_invoice" OR NEW."currency" <> st."currency" THEN
    RAISE EXCEPTION 'AYVO: a salesperson invoice is for the statement''s amount to invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."received_on" < (date_trunc('month', st."period_month"::timestamp) + interval '1 month')::date THEN
    RAISE EXCEPTION 'AYVO: a salesperson invoice is received after its month closed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."payout_on" <> "finance"."commission_payout_on"(st."period_month", NEW."received_on") THEN
    RAISE EXCEPTION 'AYVO: the payout day follows the payout rule'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "commission_salesperson_invoices_insert" BEFORE INSERT ON "finance"."commission_salesperson_invoices"
  FOR EACH ROW EXECUTE FUNCTION "finance"."commission_salesperson_invoices_insert"();

-- The audit: the invoice recorded and the payout planned, once each, only with the invoice.
ALTER TABLE "finance"."commission_statement_events" DROP CONSTRAINT "commission_statement_events_kind_check";
ALTER TABLE "finance"."commission_statement_events" ADD CONSTRAINT "commission_statement_events_kind_check"
  CHECK ("kind" IN ('APPROVED', 'SALESPERSON_INVOICE_RECORDED', 'PAYOUT_PLANNED'));
CREATE UNIQUE INDEX "commission_statement_events_one_invoice"
  ON "finance"."commission_statement_events"("statement_id") WHERE "kind" = 'SALESPERSON_INVOICE_RECORDED';
CREATE UNIQUE INDEX "commission_statement_events_one_plan"
  ON "finance"."commission_statement_events"("statement_id") WHERE "kind" = 'PAYOUT_PLANNED';
CREATE FUNCTION "finance"."commission_statement_events_insert"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."kind" <> 'APPROVED' AND NOT EXISTS (
       SELECT 1 FROM "finance"."commission_salesperson_invoices" WHERE "statement_id" = NEW."statement_id") THEN
    RAISE EXCEPTION 'AYVO: % needs the salesperson invoice of the statement', NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "commission_statement_events_insert" BEFORE INSERT ON "finance"."commission_statement_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."commission_statement_events_insert"();

CREATE TRIGGER "commission_salesperson_invoices_append_only" BEFORE UPDATE OR DELETE ON "finance"."commission_salesperson_invoices"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "commission_salesperson_invoices_no_truncate" BEFORE TRUNCATE ON "finance"."commission_salesperson_invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."commission_salesperson_invoices" TO "ayvo_finance_rw";

COMMIT;
