-- Finance — bank transactions read from Raiffeisenbank Premium API (N3B-1, doc 041; ADR 0039 §9c).
-- Runs as the owner of schema "finance". Read only towards the bank: nothing here sends a payment.
-- A synchronisation run reads one account × currency over a date window; every transaction is
-- kept once per (environment, account, currency, bank entryReference) — reading the same window
-- again never duplicates it. If the bank later returns different content for the same reference
-- (e.g. an intraday entry completed), that is a new version; nothing is overwritten or deleted.
-- No pairing with invoices here: it comes on top of the authoritative issued-invoice model (N3A-2).

-- A run is written as RUNNING and finished exactly once (SUCCEEDED / FAILED with an error code);
-- afterwards it never changes. One run per account × currency at a time: see bank_sync_slots.
CREATE TABLE "finance"."bank_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "provider" text NOT NULL CHECK ("provider" IN ('RB_PREMIUM')),
  -- PRODUCTION only in a production installation; SANDBOX = the bank's mock; TEST = a local simulation.
  "environment" text NOT NULL CHECK ("environment" IN ('PRODUCTION', 'SANDBOX', 'TEST')),
  "account_number" text NOT NULL CHECK ("account_number" ~ '^[0-9]{1,10}$'),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "from_date" date NOT NULL,
  "to_date" date NOT NULL CHECK ("to_date" >= "from_date"),
  "status" text NOT NULL DEFAULT 'RUNNING' CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  "started_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "started_by" uuid NOT NULL,
  "started_by_name" text NOT NULL,
  "finished_at" timestamptz(3),
  "pages" integer CHECK ("pages" >= 0),
  "received" integer CHECK ("received" >= 0),
  "new_count" integer CHECK ("new_count" >= 0),
  "changed_count" integer CHECK ("changed_count" >= 0),
  "error_code" text CHECK ("error_code" IS NULL OR "error_code" IN (
    'NOT_CONFIGURED', 'CERTIFICATE_UNUSABLE', 'CERTIFICATE_REJECTED', 'INSUFFICIENT_RIGHTS',
    'ACCOUNT_NOT_FOUND', 'REQUEST_REJECTED', 'RATE_LIMITED', 'BANK_UNAVAILABLE',
    'UNEXPECTED_RESPONSE', 'TOO_MANY_PAGES', 'TOO_MUCH_DATA', 'ABANDONED')),
  -- A short, secret-free explanation (never a certificate, password, client id or raw body).
  "error_detail" text CHECK ("error_detail" IS NULL OR length("error_detail") <= 500),
  CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL)),
  CHECK ("status" <> 'SUCCEEDED' OR ("pages" IS NOT NULL AND "received" IS NOT NULL
    AND "new_count" IS NOT NULL AND "changed_count" IS NOT NULL AND "error_code" IS NULL)),
  CHECK ("status" <> 'FAILED' OR "error_code" IS NOT NULL),
  CHECK ("status" <> 'RUNNING' OR "error_code" IS NULL)
);
CREATE INDEX "bank_sync_runs_account_idx"
  ON "finance"."bank_sync_runs" ("environment", "account_number", "currency", "started_at");

-- Only RUNNING → finished, once; what was asked and by whom never changes; never deleted.
CREATE FUNCTION "finance"."bank_sync_runs_guard"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: bank synchronisation runs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'RUNNING' OR NEW."status" = 'RUNNING'
     OR NEW."id" <> OLD."id" OR NEW."provider" <> OLD."provider"
     OR NEW."environment" <> OLD."environment" OR NEW."account_number" <> OLD."account_number"
     OR NEW."currency" <> OLD."currency" OR NEW."from_date" <> OLD."from_date"
     OR NEW."to_date" <> OLD."to_date" OR NEW."started_at" <> OLD."started_at"
     OR NEW."started_by" <> OLD."started_by" OR NEW."started_by_name" <> OLD."started_by_name" THEN
    RAISE EXCEPTION 'AYVO: a bank synchronisation run is finished exactly once and never changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bank_sync_runs_guard" BEFORE UPDATE OR DELETE ON "finance"."bank_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION "finance"."bank_sync_runs_guard"();
CREATE TRIGGER "bank_sync_runs_no_truncate" BEFORE TRUNCATE ON "finance"."bank_sync_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- No overlapping runs: the slot of an account × currency (current state, one row each) names the
-- run holding it. A run claims it with one conditional UPDATE (free, or held by a run started too
-- long ago — that one is then finished as ABANDONED) and frees it when it finishes. The claim is a
-- short statement, never a transaction held open while the bank is being called.
CREATE TABLE "finance"."bank_sync_slots" (
  "environment" text NOT NULL CHECK ("environment" IN ('PRODUCTION', 'SANDBOX', 'TEST')),
  "account_number" text NOT NULL CHECK ("account_number" ~ '^[0-9]{1,10}$'),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "running_run_id" uuid REFERENCES "finance"."bank_sync_runs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "claimed_at" timestamptz(3),
  CHECK (("running_run_id" IS NULL) = ("claimed_at" IS NULL)),
  PRIMARY KEY ("environment", "account_number", "currency")
);
CREATE TRIGGER "bank_sync_slots_no_delete" BEFORE DELETE ON "finance"."bank_sync_slots"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "bank_sync_slots_no_truncate" BEFORE TRUNCATE ON "finance"."bank_sync_slots"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- The identity of a bank entry; its content lives in versions (the newest is current).
CREATE TABLE "finance"."bank_transactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "environment" text NOT NULL CHECK ("environment" IN ('PRODUCTION', 'SANDBOX', 'TEST')),
  "account_number" text NOT NULL CHECK ("account_number" ~ '^[0-9]{1,10}$'),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- The bank's "unique identification of the realized transaction".
  "entry_reference" text NOT NULL CHECK (length("entry_reference") BETWEEN 1 AND 100),
  "first_run_id" uuid NOT NULL REFERENCES "finance"."bank_sync_runs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "first_seen_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("environment", "account_number", "currency", "entry_reference")
);

CREATE TABLE "finance"."bank_transaction_versions" (
  "transaction_id" uuid NOT NULL REFERENCES "finance"."bank_transactions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "run_id" uuid NOT NULL REFERENCES "finance"."bank_sync_runs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  -- SHA-256 of the entry as the bank sent it (canonical JSON): equal = nothing new.
  "content_sha256" char(64) NOT NULL CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  -- Exactly as sent (signed; never rounded — more than 2 decimals fails the run).
  "amount" numeric(19, 2) NOT NULL,
  "amount_currency" char(3) NOT NULL CHECK ("amount_currency" ~ '^[A-Z]{3}$'),
  "credit_debit" text NOT NULL CHECK ("credit_debit" IN ('CRDT', 'DBIT')),
  "booking_date" timestamptz(3),
  "value_date" timestamptz(3),
  "bank_transaction_code" text NOT NULL CHECK (length("bank_transaction_code") BETWEEN 1 AND 50),
  "end_to_end_id" text,
  "counterparty_name" text,
  "counterparty_account_prefix" text,
  "counterparty_account_number" text,
  "counterparty_bank_code" text,
  "counterparty_iban" text,
  "variable_symbol" text,
  "constant_symbol" text,
  "specific_symbol" text,
  "message" text,
  "originator_message" text,
  "instructed_amount" numeric(19, 2),
  "instructed_currency" char(3) CHECK ("instructed_currency" IS NULL OR "instructed_currency" ~ '^[A-Z]{3}$'),
  -- The entry as received: canonical JSON text (sorted keys, every number exactly as sent).
  "raw" text NOT NULL CHECK (length("raw") <= 100000 AND ("raw"::jsonb) IS NOT NULL),
  PRIMARY KEY ("transaction_id", "version")
);
CREATE INDEX "bank_transaction_versions_run_idx" ON "finance"."bank_transaction_versions" ("run_id");

-- Append-only, also for the schema owner.
CREATE TRIGGER "bank_transactions_append_only" BEFORE UPDATE OR DELETE ON "finance"."bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "bank_transactions_no_truncate" BEFORE TRUNCATE ON "finance"."bank_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "bank_transaction_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."bank_transaction_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "bank_transaction_versions_no_truncate" BEFORE TRUNCATE ON "finance"."bank_transaction_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- The runtime role appends transactions and finishes its own runs (guarded above).
GRANT SELECT, INSERT ON "finance"."bank_transactions", "finance"."bank_transaction_versions" TO "ayvo_finance_rw";
GRANT SELECT, INSERT, UPDATE ON "finance"."bank_sync_runs", "finance"."bank_sync_slots" TO "ayvo_finance_rw";
