-- Sending an invoice's stored PDF by e-mail (doc 043, owner 2026-10-30). SMTP has no idempotency, so
-- a delivery is sent automatically at most once after its message may have left: SENDING is
-- committed before the connection opens, an interrupted one becomes UNCERTAIN and never returns to
-- the queue. SENT means the relay accepted the message, not that it reached the mailbox.
ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT', 'INVOICE_TEST_ISSUE', 'INVOICE_TEST_CANCEL', 'INVOICE_TEST_RUN',
                    'PAYMENTS_SIMULATE', 'PAYMENTS_IMPORT_BANK', 'PAYMENT_ALLOCATE',
                    'INVOICE_DELIVERY_REQUEST', 'INVOICE_DELIVERY_RETRY'));

CREATE TABLE "finance"."invoice_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "invoice_id" uuid NOT NULL REFERENCES "finance"."invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "customer_id" uuid NOT NULL,
  "customer_version" integer NOT NULL,
  "recipient" text NOT NULL CHECK (length("recipient") BETWEEN 3 AND 254),
  "sender_name" text NOT NULL,
  "sender_address" text NOT NULL,
  "reply_to" text NOT NULL,
  "language" text NOT NULL CHECK ("language" IN ('cs', 'en', 'de')),
  "template_version" integer NOT NULL,
  "message_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'QUEUED'
    CHECK ("state" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN')),
  "attempt_of" uuid UNIQUE REFERENCES "finance"."invoice_deliveries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "retry_reason" text,
  "duplicate_risk_acknowledged" boolean NOT NULL DEFAULT false,
  "request_id" uuid NOT NULL UNIQUE,
  "requested_by" uuid NOT NULL,
  "requested_by_name" text NOT NULL,
  "requested_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "send_attempts" integer NOT NULL DEFAULT 0 CHECK ("send_attempts" >= 0),
  "next_attempt_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "lease_until" timestamptz(3),
  "last_code" text,
  "finished_at" timestamptz(3),
  -- A retry names why and that the possible duplicate was understood; a first sending does neither.
  CHECK (("attempt_of" IS NULL AND "retry_reason" IS NULL AND NOT "duplicate_risk_acknowledged")
      OR ("attempt_of" IS NOT NULL AND length(btrim("retry_reason")) BETWEEN 3 AND 500
          AND "duplicate_risk_acknowledged")),
  CHECK (("state" IN ('SENT', 'FAILED', 'UNCERTAIN')) = ("finished_at" IS NOT NULL)),
  CONSTRAINT "invoice_deliveries_customer_version_fkey" FOREIGN KEY ("customer_id", "customer_version")
    REFERENCES "finance"."customer_versions" ("customer_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- One chain per invoice: one first sending, each retry follows exactly one earlier attempt.
CREATE UNIQUE INDEX "invoice_deliveries_first_key" ON "finance"."invoice_deliveries" ("invoice_id")
  WHERE "attempt_of" IS NULL;
-- At most one live delivery per invoice.
CREATE UNIQUE INDEX "invoice_deliveries_live_key" ON "finance"."invoice_deliveries" ("invoice_id")
  WHERE "state" IN ('QUEUED', 'SENDING');
CREATE INDEX "invoice_deliveries_queue_idx" ON "finance"."invoice_deliveries" ("next_attempt_at")
  WHERE "state" = 'QUEUED';
CREATE INDEX "invoice_deliveries_lease_idx" ON "finance"."invoice_deliveries" ("lease_until")
  WHERE "state" = 'SENDING';

CREATE TABLE "finance"."invoice_delivery_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "delivery_id" uuid NOT NULL REFERENCES "finance"."invoice_deliveries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "state" text NOT NULL,
  "code" text,
  "attempt" integer NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "invoice_delivery_events_delivery_idx"
  ON "finance"."invoice_delivery_events" ("delivery_id", "occurred_at");

CREATE FUNCTION "finance"."invoice_delivery_insert_check"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  previous "finance"."invoice_deliveries"%ROWTYPE;
BEGIN
  IF NEW."state" <> 'QUEUED' THEN
    RAISE EXCEPTION 'AYVO: a delivery starts queued' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c WHERE c."invoice_id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'AYVO: a cancelled invoice is not sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempt_of" IS NOT NULL THEN
    SELECT * INTO previous FROM "finance"."invoice_deliveries" WHERE "id" = NEW."attempt_of";
    IF previous."invoice_id" <> NEW."invoice_id" OR previous."state" NOT IN ('FAILED', 'UNCERTAIN')
       OR previous."message_id" <> NEW."message_id" THEN
      RAISE EXCEPTION 'AYVO: a retry follows a failed or uncertain attempt of the same invoice, with its Message-ID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "invoice_delivery_insert_check" BEFORE INSERT ON "finance"."invoice_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "finance"."invoice_delivery_insert_check"();

-- Only the working columns change, only forward; a finished delivery never changes.
CREATE FUNCTION "finance"."invoice_delivery_update_check"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'send_attempts', 'next_attempt_at', 'lease_until', 'last_code', 'finished_at'])
     <> (to_jsonb(OLD) - ARRAY['state', 'send_attempts', 'next_attempt_at', 'lease_until', 'last_code', 'finished_at']) THEN
    RAISE EXCEPTION 'AYVO: what a delivery sends and to whom never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD."state" = 'QUEUED' AND NEW."state" = 'SENDING')
       OR (OLD."state" = 'SENDING' AND NEW."state" IN ('QUEUED', 'SENT', 'FAILED', 'UNCERTAIN'))) THEN
    RAISE EXCEPTION 'AYVO: delivery state % cannot become %', OLD."state", NEW."state"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "invoice_delivery_update_check" BEFORE UPDATE ON "finance"."invoice_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "finance"."invoice_delivery_update_check"();

-- The history is written by the database in the same transaction as the state it records.
CREATE FUNCTION "finance"."invoice_delivery_record_event"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  INSERT INTO "finance"."invoice_delivery_events" ("delivery_id", "state", "code", "attempt")
  VALUES (NEW."id", NEW."state", NEW."last_code", NEW."send_attempts");
  RETURN NULL;
END
$$;
CREATE TRIGGER "invoice_delivery_record_event" AFTER INSERT OR UPDATE ON "finance"."invoice_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "finance"."invoice_delivery_record_event"();

CREATE TRIGGER "invoice_deliveries_no_delete" BEFORE DELETE ON "finance"."invoice_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_deliveries_no_truncate" BEFORE TRUNCATE ON "finance"."invoice_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_delivery_events_append_only" BEFORE UPDATE OR DELETE ON "finance"."invoice_delivery_events"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "invoice_delivery_events_no_truncate" BEFORE TRUNCATE ON "finance"."invoice_delivery_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT, UPDATE ON "finance"."invoice_deliveries" TO "ayvo_finance_rw";
GRANT SELECT, INSERT ON "finance"."invoice_delivery_events" TO "ayvo_finance_rw";
