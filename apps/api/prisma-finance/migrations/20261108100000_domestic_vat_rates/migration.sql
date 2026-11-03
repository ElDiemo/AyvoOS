-- Finance — the default VAT rate of domestic invoices (owner 2026-11-03, doc 040 §17): entered by
-- the administrator in percent, valid from a day, never a default and never hard-coded. Prices per
-- room and month are without VAT. Append-only; a later revision with the same start day corrects
-- it. Nothing here issues a live invoice, computes VAT on a TEST invoice or changes an issued one.

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
                    'BILLING_RUN_SETTINGS_VERSION', 'ISSUER_VAT_RATE'));

CREATE TABLE "finance"."domestic_vat_rates" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  -- From the counter billing_revision: commit order (the newest of a start day is the correction).
  "revision" bigint NOT NULL UNIQUE,
  -- The first tax point (a Prague calendar day) the rate applies to.
  "valid_from" date NOT NULL,
  -- Percent, exact; more than 0 and less than 100 (no default). No typmod: numeric(5,2) would
  -- round 21.123 to 21.12 before any CHECK — here more than two decimals are refused, never rounded.
  "rate_percent" numeric NOT NULL
    CHECK ("rate_percent" > 0 AND "rate_percent" < 100 AND scale("rate_percent") <= 2),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);
CREATE INDEX "domestic_vat_rates_valid_from_idx" ON "finance"."domestic_vat_rates" ("valid_from", "revision");

CREATE TRIGGER "domestic_vat_rates_append_only" BEFORE UPDATE OR DELETE ON "finance"."domestic_vat_rates"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "domestic_vat_rates_no_truncate" BEFORE TRUNCATE ON "finance"."domestic_vat_rates"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."domestic_vat_rates" TO "ayvo_finance_rw";
