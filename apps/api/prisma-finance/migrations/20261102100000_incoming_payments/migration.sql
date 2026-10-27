-- Finance — incoming payments and the payment state of invoices (N3B-2, doc 041 §8; owner
-- 2026-10-27): the end of the DEV billing chain (TEST invoice → payment → state), without any live
-- bank action. Payments come from two sources, each recorded once:
--   * BANK: a credit bank transaction already read from RB (doc 041), key = the transaction;
--   * SIMULATION: a simulated statement entry (only outside production), key = its reference.
-- A repeated import or simulation of the same entries never records or counts anything twice
-- (UNIQUE (source, source_key)).
-- Matching is deterministic: AUTO only on an exact variable symbol of exactly one open invoice in
-- the same currency and an allowed environment; everything else is a review with its reason. A
-- MANUAL allocation needs a reason. Allocations are append-only and never exceed the payment or
-- the invoice; a TEST invoice takes no PRODUCTION payment; an invoice with payments is not
-- cancelled.

INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('incoming_payment', 0);

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT', 'INVOICE_TEST_ISSUE', 'INVOICE_TEST_CANCEL',
                    'PAYMENTS_SIMULATE', 'PAYMENTS_IMPORT_BANK', 'PAYMENT_ALLOCATE'));

CREATE TABLE "finance"."incoming_payments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^PP-[0-9]{6,}$'),
  "source" text NOT NULL CHECK ("source" IN ('BANK', 'SIMULATION')),
  "source_key" text NOT NULL CHECK (length("source_key") BETWEEN 1 AND 100),
  "environment" text NOT NULL CHECK ("environment" IN ('PRODUCTION', 'SANDBOX', 'TEST', 'SIMULATION')),
  "bank_transaction_id" uuid REFERENCES "finance"."bank_transactions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "bank_transaction_version" integer,
  "amount" numeric(19, 2) NOT NULL CHECK ("amount" > 0),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "booked_on" date NOT NULL,
  "variable_symbol" text CHECK ("variable_symbol" IS NULL OR "variable_symbol" ~ '^[0-9]{1,10}$'),
  "counterparty_name" text CHECK ("counterparty_name" IS NULL OR length("counterparty_name") <= 200),
  "counterparty_account" text CHECK ("counterparty_account" IS NULL OR length("counterparty_account") <= 60),
  "message" text CHECK ("message" IS NULL OR length("message") <= 500),
  -- The outcome of the automatic matching when recorded (never changed; later manual
  -- allocations are separate rows).
  "match_result" text NOT NULL CHECK ("match_result" IN ('MATCHED', 'PARTIAL_OVERPAYMENT',
    'NO_VARIABLE_SYMBOL', 'UNKNOWN_VARIABLE_SYMBOL', 'CURRENCY_MISMATCH', 'ENVIRONMENT_MISMATCH',
    'INVOICE_CANCELLED', 'INVOICE_ALREADY_PAID')),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  UNIQUE ("source", "source_key"),
  CHECK (("source" = 'BANK') = ("bank_transaction_id" IS NOT NULL AND "bank_transaction_version" IS NOT NULL)),
  CHECK (("source" = 'SIMULATION') = ("environment" = 'SIMULATION')),
  CHECK ("source" <> 'BANK' OR "source_key" = "bank_transaction_id"::text)
);
CREATE INDEX "incoming_payments_vs_idx" ON "finance"."incoming_payments" ("variable_symbol");

CREATE TABLE "finance"."payment_allocations" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "payment_id" uuid NOT NULL REFERENCES "finance"."incoming_payments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "invoice_id" uuid NOT NULL REFERENCES "finance"."invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amount" numeric(19, 2) NOT NULL CHECK ("amount" > 0),
  "kind" text NOT NULL CHECK ("kind" IN ('AUTO', 'MANUAL')),
  "reason" text CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid,
  CHECK (("kind" = 'MANUAL') = ("reason" IS NOT NULL))
);
CREATE INDEX "payment_allocations_payment_idx" ON "finance"."payment_allocations" ("payment_id");
CREATE INDEX "payment_allocations_invoice_idx" ON "finance"."payment_allocations" ("invoice_id");

-- An allocation fits its payment and its invoice. Locks serialise concurrent allocations of the
-- same payment or invoice (in a fixed order: payment, then invoice).
CREATE FUNCTION "finance"."payment_allocations_check"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  p record;
  i record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('payment:' || NEW."payment_id"::text));
  PERFORM pg_advisory_xact_lock(hashtext('invoice-payments:' || NEW."invoice_id"::text));
  SELECT * INTO p FROM "finance"."incoming_payments" WHERE "id" = NEW."payment_id";
  SELECT * INTO i FROM "finance"."invoices" WHERE "id" = NEW."invoice_id";
  IF p."currency" <> i."currency" THEN
    RAISE EXCEPTION 'AYVO: a payment pays an invoice of its own currency' USING ERRCODE = 'check_violation';
  END IF;
  IF i."kind" = 'TEST' AND p."environment" = 'PRODUCTION' THEN
    RAISE EXCEPTION 'AYVO: a TEST invoice takes no production payment' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" WHERE "invoice_id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'AYVO: a cancelled invoice takes no payment' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT coalesce(sum("amount"), 0) FROM "finance"."payment_allocations" WHERE "payment_id" = NEW."payment_id")
     + NEW."amount" > p."amount" THEN
    RAISE EXCEPTION 'AYVO: allocations never exceed the payment' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT coalesce(sum("amount"), 0) FROM "finance"."payment_allocations" WHERE "invoice_id" = NEW."invoice_id")
     + NEW."amount" > i."total" THEN
    RAISE EXCEPTION 'AYVO: allocations never exceed the invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payment_allocations_check" BEFORE INSERT ON "finance"."payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."payment_allocations_check"();

-- An invoice with payments is not cancelled (the money would be left without its invoice).
CREATE FUNCTION "finance"."invoice_cancellations_unpaid"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('invoice-payments:' || NEW."invoice_id"::text));
  IF EXISTS (SELECT 1 FROM "finance"."payment_allocations" WHERE "invoice_id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'AYVO: an invoice with payments is not cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "invoice_cancellations_unpaid" BEFORE INSERT ON "finance"."invoice_cancellations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."invoice_cancellations_unpaid"();

CREATE TRIGGER "incoming_payments_append_only" BEFORE UPDATE OR DELETE ON "finance"."incoming_payments"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "incoming_payments_no_truncate" BEFORE TRUNCATE ON "finance"."incoming_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "payment_allocations_append_only" BEFORE UPDATE OR DELETE ON "finance"."payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "payment_allocations_no_truncate" BEFORE TRUNCATE ON "finance"."payment_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."incoming_payments", "finance"."payment_allocations" TO "ayvo_finance_rw";
