-- Finance — hotel billing settings (doc 040, N3A-1; ADR 0039 §10). Runs as the owner of schema
-- "finance". Finance is the only owner of customers (the billed company — not the hotel), hotel
-- billing agreements (billed rooms, own price, currency, payment terms) and the default price
-- list; the hotel itself stays in the core and is referenced by its id (no cross-schema FK).
-- Every row is append-only: a change or a correction is a new version with its author and reason
-- (bitemporal: effective_from = business time, recorded_at = when it was known). No amounts are
-- computed here and no VAT, numbering or invoice exists yet (N3A-2).
--
-- Order of corrections: price list and agreement versions carry a "revision" from the gapless
-- counter billing_revision. Its row stays locked until the writing transaction commits, so the
-- revisions follow the commit order and are never tied — the newest revision is the later
-- correction, whatever the clock says. recorded_at is clock_timestamp() (taken after that lock,
-- not at the transaction start), so it never runs against the revisions or the version numbers.

INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES ('customer', 0), ('billing_agreement', 0),
  ('billing_revision', 0);

ALTER TABLE "finance"."operation_requests" DROP CONSTRAINT "operation_requests_kind_check";
ALTER TABLE "finance"."operation_requests" ADD CONSTRAINT "operation_requests_kind_check"
  CHECK ("kind" IN ('FINANCE_DOCUMENT_RECEIVE', 'FINANCE_DOCUMENT_TAKEOVER',
                    'ACCOUNTING_EXPORT_CREATE', 'ACCOUNTING_EXPORT_HANDOVER',
                    'BILLING_CUSTOMER_CREATE', 'BILLING_CUSTOMER_VERSION',
                    'BILLING_PRICE_VERSION', 'BILLING_AGREEMENT_CREATE', 'BILLING_AGREEMENT_VERSION'));

-- The billed company (odběratel). Its details live in versions; the newest version is current.
CREATE TABLE "finance"."customers" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^CU-[0-9]{6,}$'),
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_by" uuid NOT NULL,
  "created_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);

CREATE TABLE "finance"."customer_versions" (
  "customer_id" uuid NOT NULL REFERENCES "finance"."customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "legal_name" text NOT NULL CHECK (length(btrim("legal_name")) BETWEEN 1 AND 200),
  -- As written by the person (CZ IČO is checked by the application); never an identity of a hotel.
  "company_id" text CHECK ("company_id" IS NULL OR length(btrim("company_id")) BETWEEN 1 AND 30),
  "vat_id" text CHECK ("vat_id" IS NULL OR length(btrim("vat_id")) BETWEEN 1 AND 30),
  "address_line1" text NOT NULL CHECK (length(btrim("address_line1")) BETWEEN 1 AND 200),
  "address_line2" text CHECK ("address_line2" IS NULL OR length(btrim("address_line2")) BETWEEN 1 AND 200),
  "postal_code" text NOT NULL CHECK (length(btrim("postal_code")) BETWEEN 1 AND 20),
  "city" text NOT NULL CHECK (length(btrim("city")) BETWEEN 1 AND 100),
  "country_code" char(2) NOT NULL CHECK ("country_code" ~ '^[A-Z]{2}$'),
  "billing_email" text NOT NULL CHECK ("billing_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length("billing_email") <= 254),
  "reason" text CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  PRIMARY KEY ("customer_id", "version"),
  -- The first version is the creation; every later one says why.
  CHECK ("version" = 1 OR "reason" IS NOT NULL)
);

-- The default price per room and month, per currency. Effective from the first day of a month;
-- a correction is a new row with the same effective_from (the newest revision wins).
CREATE TABLE "finance"."price_list_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "revision" bigint NOT NULL UNIQUE,
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "price_per_room_month" numeric(19, 2) NOT NULL CHECK ("price_per_room_month" >= 0),
  "effective_from" date NOT NULL CHECK (extract(day FROM "effective_from") = 1),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);
CREATE INDEX "price_list_versions_lookup_idx"
  ON "finance"."price_list_versions" ("currency", "effective_from", "revision");

-- One billing agreement per hotel (core hotel id + its code/name as of the creation; the current
-- name comes through the core contract). The terms live in versions.
CREATE TABLE "finance"."billing_agreements" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "serial" bigint NOT NULL UNIQUE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^BA-[0-9]{6,}$'),
  "hotel_id" uuid NOT NULL UNIQUE,
  "hotel_code" text NOT NULL,
  "hotel_name" text NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_by" uuid NOT NULL,
  "created_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);

CREATE TABLE "finance"."agreement_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "revision" bigint NOT NULL UNIQUE,
  "agreement_id" uuid NOT NULL REFERENCES "finance"."billing_agreements" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Business time: the first month these terms apply to (mid-month changes are not decided).
  "effective_from" date NOT NULL CHECK (extract(day FROM "effective_from") = 1),
  "customer_id" uuid NOT NULL REFERENCES "finance"."customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "contract_number" text CHECK ("contract_number" IS NULL OR length(btrim("contract_number")) BETWEEN 1 AND 100),
  "billed_rooms" integer NOT NULL CHECK ("billed_rooms" > 0),
  -- NULL = the default price list of the currency; an explicit 0.00 is a price, not a gap.
  "own_price_per_room_month" numeric(19, 2) CHECK ("own_price_per_room_month" IS NULL OR "own_price_per_room_month" >= 0),
  "currency" char(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "payment_terms_days" integer NOT NULL CHECK ("payment_terms_days" BETWEEN 0 AND 365),
  -- Explicit, no default: invoiced in advance or in arrears (the issuing window is decided later).
  "billing_timing" text NOT NULL CHECK ("billing_timing" IN ('ADVANCE', 'ARREARS')),
  "valid_from" date NOT NULL,
  "valid_to" date CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "recorded_by" uuid NOT NULL,
  "recorded_by_name" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE
);
CREATE INDEX "agreement_versions_lookup_idx"
  ON "finance"."agreement_versions" ("agreement_id", "effective_from", "revision");
CREATE INDEX "agreement_versions_customer_idx" ON "finance"."agreement_versions" ("customer_id");

-- Append-only, also for the schema owner: no UPDATE, DELETE or TRUNCATE.
CREATE TRIGGER "customers_append_only" BEFORE UPDATE OR DELETE ON "finance"."customers"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "customers_no_truncate" BEFORE TRUNCATE ON "finance"."customers"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "customer_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."customer_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "customer_versions_no_truncate" BEFORE TRUNCATE ON "finance"."customer_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "price_list_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."price_list_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "price_list_versions_no_truncate" BEFORE TRUNCATE ON "finance"."price_list_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_agreements_append_only" BEFORE UPDATE OR DELETE ON "finance"."billing_agreements"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "billing_agreements_no_truncate" BEFORE TRUNCATE ON "finance"."billing_agreements"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "agreement_versions_append_only" BEFORE UPDATE OR DELETE ON "finance"."agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."reject_modification"();
CREATE TRIGGER "agreement_versions_no_truncate" BEFORE TRUNCATE ON "finance"."agreement_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "finance"."reject_modification"();

-- The runtime role reads and appends only (no UPDATE: nothing here is ever changed in place).
GRANT SELECT, INSERT ON "finance"."customers", "finance"."customer_versions",
  "finance"."price_list_versions", "finance"."billing_agreements", "finance"."agreement_versions"
  TO "ayvo_finance_rw";
