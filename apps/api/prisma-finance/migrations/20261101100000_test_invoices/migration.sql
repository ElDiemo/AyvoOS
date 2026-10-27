-- Finance — TEST invoices (N3A-2b, doc 040 §9; owner 2026-10-27): a testable chain on DEV from the
-- hotel settings to an invoice with its PDF and QR Platba. Only kind TEST exists (DB CHECK) and
-- the API refuses it with APP_ENV=production: no live issuing, no sending to hotels.
--   * one invoice = one customer, one currency, one month; a line per hotel agreement (one line =
--     a separate invoice, several = a summary of the same customer — never two customers);
--   * the issuer, customer, account, lines and payment instructions are frozen in `snapshot`; the
--     PDF is rendered from it, stored create-only and identified by its SHA-256;
--   * at most one valid (not cancelled) TEST invoice per agreement and month; a cancellation is
--     a separate record with a reason — an invoice is never changed or deleted;
--   * amounts exact: line = billed rooms × unit price; total = Σ lines (checked at commit).

INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('invoice_test', 0);

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT', 'INVOICE_TEST_ISSUE', 'INVOICE_TEST_CANCEL'));

CREATE TABLE "finance"."invoices" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "kind" text NOT NULL CHECK ("kind" = 'TEST'),
  "number" text NOT NULL UNIQUE CHECK ("number" ~ '^T[0-9]{4}-[0-9]{5}$'),
  "variable_symbol" text NOT NULL UNIQUE CHECK ("variable_symbol" ~ '^[0-9]{1,10}$'),
  "customer_id" uuid NOT NULL,
  "customer_version" integer NOT NULL,
  "period_month" date NOT NULL CHECK (extract(day FROM "period_month") = 1),
  "issued_on" date NOT NULL,
  "due_on" date NOT NULL,
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "total" numeric(19, 2) NOT NULL CHECK ("total" > 0),
  "snapshot" jsonb NOT NULL,
  "pdf_storage_key" text NOT NULL UNIQUE,
  "pdf_sha256" char(64) NOT NULL CHECK ("pdf_sha256" ~ '^[0-9a-f]{64}$'),
  "issued_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "issued_by" uuid NOT NULL,
  "issued_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  CHECK ("due_on" >= "issued_on"),
  CONSTRAINT "invoices_customer_id_customer_version_fkey" FOREIGN KEY ("customer_id", "customer_version")
    REFERENCES "finance"."customer_versions" ("customer_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "invoices_customer_idx" ON "finance"."invoices" ("customer_id", "period_month");

CREATE TABLE "finance"."invoice_lines" (
  "invoice_id" uuid NOT NULL REFERENCES "finance"."invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "line_no" integer NOT NULL CHECK ("line_no" >= 1),
  "agreement_id" uuid NOT NULL REFERENCES "finance"."billing_agreements" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "agreement_revision" bigint NOT NULL REFERENCES "finance"."agreement_versions" ("revision") ON DELETE RESTRICT ON UPDATE CASCADE,
  "period_month" date NOT NULL,
  "hotel_id" uuid NOT NULL,
  "hotel_code" text NOT NULL,
  "hotel_name" text NOT NULL,
  "billed_rooms" integer NOT NULL CHECK ("billed_rooms" >= 1),
  "unit_price" numeric(19, 2) NOT NULL CHECK ("unit_price" >= 0),
  "amount" numeric(19, 2) NOT NULL,
  PRIMARY KEY ("invoice_id", "line_no"),
  CHECK ("amount" = "billed_rooms" * "unit_price")
);
CREATE INDEX "invoice_lines_agreement_idx" ON "finance"."invoice_lines" ("agreement_id", "period_month");

CREATE TABLE "finance"."invoice_cancellations" (
  "invoice_id" uuid PRIMARY KEY REFERENCES "finance"."invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  "cancelled_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "cancelled_by" uuid NOT NULL,
  "cancelled_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);

-- A line belongs to its invoice's month and is the only valid line of its agreement for it.
-- The advisory lock serialises concurrent issuing for the same agreement and month.
CREATE FUNCTION "finance"."invoice_lines_check"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."period_month" <> (SELECT "period_month" FROM "finance"."invoices" WHERE "id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'AYVO: an invoice line bills its invoice''s month' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "agreement_id" FROM "finance"."agreement_versions" WHERE "revision" = NEW."agreement_revision")
     <> NEW."agreement_id" THEN
    RAISE EXCEPTION 'AYVO: the line''s terms belong to another agreement' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice:' || NEW."agreement_id"::text || ':' || NEW."period_month"::text));
  IF EXISTS (
    SELECT 1 FROM "finance"."invoice_lines" l
      WHERE l."agreement_id" = NEW."agreement_id" AND l."period_month" = NEW."period_month"
        AND l."invoice_id" <> NEW."invoice_id"
        AND NOT EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c WHERE c."invoice_id" = l."invoice_id")) THEN
    RAISE EXCEPTION 'AYVO: the agreement already has a valid invoice for this month'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "invoice_lines_check" BEFORE INSERT ON "finance"."invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "finance"."invoice_lines_check"();

-- At commit: an invoice has lines, numbered 1..n, and its total is exactly their sum.
CREATE FUNCTION "finance"."invoices_complete"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  n int;
  top int;
  s numeric;
BEGIN
  SELECT count(*), max("line_no"), sum("amount") INTO n, top, s
    FROM "finance"."invoice_lines" WHERE "invoice_id" = NEW."id";
  IF n = 0 OR top <> n OR s IS DISTINCT FROM NEW."total" THEN
    RAISE EXCEPTION 'AYVO: an invoice has lines 1..n whose sum is its total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "invoices_complete" AFTER INSERT ON "finance"."invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "finance"."invoices_complete"();

-- Append-only, also for the schema owner.
CREATE TRIGGER "invoices_append_only" BEFORE UPDATE OR DELETE ON "finance"."invoices"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoices_no_truncate" BEFORE TRUNCATE ON "finance"."invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_lines_append_only" BEFORE UPDATE OR DELETE ON "finance"."invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_lines_no_truncate" BEFORE TRUNCATE ON "finance"."invoice_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_cancellations_append_only" BEFORE UPDATE OR DELETE ON "finance"."invoice_cancellations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_cancellations_no_truncate" BEFORE TRUNCATE ON "finance"."invoice_cancellations"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."invoices", "finance"."invoice_lines",
  "finance"."invoice_cancellations" TO "ayvo_finance_rw";
