-- Finance — our company as the issuer of invoices and the bank accounts printed on them (N3A-2a,
-- doc 040 §8; ADR 0039). Finance is the only place these are kept: a site is not a legal entity
-- (doc 022 §1) and nothing in the core holds an invoicing identity. Every change is a new version
-- with its author and reason (append-only); an issued invoice keeps its own snapshot (N3A-2b).
-- The invoice recipient account is not the bank connection that reads transactions (doc 041).

INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('issuer_bank_account', 0);

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION',
                    'ISSUER_VERSION', 'ISSUER_ACCOUNT_CREATE', 'ISSUER_ACCOUNT_VERSION',
                    'ISSUER_DEFAULT_ACCOUNT'));

-- The issuer: one company, its details in versions 1…n (the newest is current).
CREATE TABLE "finance"."issuer_versions" (
  "version" integer PRIMARY KEY CHECK ("version" >= 1),
  "legal_name" text NOT NULL CHECK (length(btrim("legal_name")) BETWEEN 1 AND 200),
  "address_line1" text NOT NULL CHECK (length(btrim("address_line1")) BETWEEN 1 AND 200),
  "address_line2" text CHECK ("address_line2" IS NULL OR length(btrim("address_line2")) BETWEEN 1 AND 200),
  "postal_code" text NOT NULL CHECK (length(btrim("postal_code")) BETWEEN 1 AND 20),
  "city" text NOT NULL CHECK (length(btrim("city")) BETWEEN 1 AND 100),
  "country_code" char(2) NOT NULL CHECK ("country_code" ~ '^[A-Z]{2}$'),
  "company_id" text NOT NULL CHECK (length(btrim("company_id")) BETWEEN 1 AND 30),
  -- Explicit, no default (an unknown status cannot be stored, so it blocks issuing by absence).
  "vat_status" text NOT NULL CHECK ("vat_status" IN ('VAT_PAYER', 'NOT_VAT_PAYER')),
  "vat_id" text CHECK ("vat_id" IS NULL OR length(btrim("vat_id")) BETWEEN 1 AND 30),
  "registration" text CHECK ("registration" IS NULL OR length(btrim("registration")) BETWEEN 1 AND 300),
  "email" text NOT NULL CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length("email") <= 254),
  "phone" text CHECK ("phone" IS NULL OR length(btrim("phone")) BETWEEN 1 AND 40),
  "web" text CHECK ("web" IS NULL OR length(btrim("web")) BETWEEN 1 AND 200),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  CHECK ("vat_status" <> 'VAT_PAYER' OR "vat_id" IS NOT NULL)
);

-- A bank account printed on invoices; its details in versions. Never deleted (RETIRED instead).
CREATE TABLE "finance"."issuer_bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^IB-[0-9]{6,}$'),
  "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "created_by" uuid NOT NULL,
  "created_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);

CREATE TABLE "finance"."issuer_bank_account_versions" (
  "account_id" uuid NOT NULL REFERENCES "finance"."issuer_bank_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "status" text NOT NULL CHECK ("status" IN ('ACTIVE', 'RETIRED')),
  "label" text NOT NULL CHECK (length(btrim("label")) BETWEEN 1 AND 100),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "account_prefix" text CHECK ("account_prefix" IS NULL OR "account_prefix" ~ '^[0-9]{1,6}$'),
  "account_number" text CHECK ("account_number" IS NULL OR "account_number" ~ '^[0-9]{2,10}$'),
  "bank_code" text CHECK ("bank_code" IS NULL OR "bank_code" ~ '^[0-9]{4}$'),
  -- Checked (mod 97, CZ = the domestic number) by the API; the shape here.
  "iban" text NOT NULL CHECK ("iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  "bic" text CHECK ("bic" IS NULL OR "bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  PRIMARY KEY ("account_id", "version"),
  CHECK (("account_number" IS NULL) = ("bank_code" IS NULL)),
  CHECK ("account_prefix" IS NULL OR "account_number" IS NOT NULL)
);

-- The default account of a currency: a choice in revisions (counter billing_revision, commit
-- order); the newest revision of a currency is current. One account is chosen, never two.
CREATE TABLE "finance"."issuer_default_accounts" (
  "revision" bigint PRIMARY KEY,
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "account_id" uuid NOT NULL REFERENCES "finance"."issuer_bank_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);
CREATE INDEX "issuer_default_accounts_currency_idx"
  ON "finance"."issuer_default_accounts" ("currency", "revision");

-- Append-only, also for the schema owner.
CREATE TRIGGER "issuer_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."issuer_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_versions_no_truncate" BEFORE TRUNCATE ON "finance"."issuer_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_bank_accounts_append_only" BEFORE UPDATE OR DELETE ON "finance"."issuer_bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_bank_accounts_no_truncate" BEFORE TRUNCATE ON "finance"."issuer_bank_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_bank_account_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."issuer_bank_account_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_bank_account_versions_no_truncate" BEFORE TRUNCATE ON "finance"."issuer_bank_account_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_default_accounts_append_only" BEFORE UPDATE OR DELETE ON "finance"."issuer_default_accounts"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "issuer_default_accounts_no_truncate" BEFORE TRUNCATE ON "finance"."issuer_default_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

GRANT SELECT, INSERT ON "finance"."issuer_versions", "finance"."issuer_bank_accounts",
  "finance"."issuer_bank_account_versions", "finance"."issuer_default_accounts" TO "ayvo_finance_rw";
