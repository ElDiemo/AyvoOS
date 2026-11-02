-- Finance — the settings of the monthly invoicing run (owner 2026-11-02, doc 040 §11 and §13): the
-- issue day and which month an invoice of each billing timing bills. Never a default: without a
-- version, the planned run is blocked and says so. The due date stays the agreement's payment terms.
-- Versions are append-only; the newest applies. Nothing here issues or sends anything.

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
                    'BILLING_RUN_SETTINGS_VERSION'));

CREATE TABLE "finance"."billing_run_settings" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  -- From the counter billing_revision: commit order (the newest is the later correction).
  "revision" bigint NOT NULL UNIQUE,
  -- 1–28: every month has the day.
  "issue_day" smallint NOT NULL CHECK ("issue_day" BETWEEN 1 AND 28),
  -- The month an ADVANCE agreement's invoice bills, relative to the month it is issued in.
  "advance_billed_month" text NOT NULL CHECK ("advance_billed_month" IN ('ISSUE_MONTH', 'NEXT_MONTH')),
  -- The month an ARREARS agreement's invoice bills, relative to the month it is issued in.
  "arrears_billed_month" text NOT NULL CHECK ("arrears_billed_month" IN ('PREVIOUS_MONTH', 'ISSUE_MONTH')),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);

CREATE TRIGGER "billing_run_settings_append_only" BEFORE UPDATE OR DELETE ON "finance"."billing_run_settings"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_run_settings_no_truncate" BEFORE TRUNCATE ON "finance"."billing_run_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."billing_run_settings" TO "ayvo_finance_rw";
