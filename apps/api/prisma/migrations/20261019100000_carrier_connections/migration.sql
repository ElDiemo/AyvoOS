-- Carrier connections managed in the administration (ADR 0027, doc 029 §9). Additive.
--
-- 1. The carrier ACCOUNT a shipment and each of its requests were made with (a fingerprint of the
--    client id — never the id or a secret). Existing shipments are verified, polled and cancelled
--    only with this same account: replacing the credentials with another account never redirects
--    them (they show "the connection is not available" instead).
ALTER TABLE "shipments" ADD COLUMN "carrier_account" TEXT;
ALTER TABLE "shipment_carrier_requests" ADD COLUMN "carrier_account" TEXT;
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_carrier_account_check" CHECK (
    "carrier_account" IS NULL OR ("carrier_code" IS NOT NULL AND "carrier_account" ~ '^[a-z0-9-]{4,64}$'));
ALTER TABLE "shipment_carrier_requests"
  ADD CONSTRAINT "shipment_carrier_requests_carrier_account_check" CHECK (
    "carrier_account" IS NULL OR "carrier_account" ~ '^[a-z0-9-]{4,64}$');

-- The account is part of the carrier recorded once (as code, connection and environment).
CREATE OR REPLACE FUNCTION shipments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','carrier_code','carrier_connection','carrier_environment','carrier_account',
                          'carrier_shipment_ref','labeled_at','cancelled_at','cancelled_by',
                          'cancel_reason','carrier_cancelled_at','cancel_requested_at',
                          'cancel_requested_by','carrier_cancel_sent_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: shipments are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a shipment''s identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'AYVO: a cancelled shipment never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The carrier may change only while nothing is at a carrier (a draft after a refusal).
  IF (OLD."carrier_code" IS NOT NULL AND OLD."status" <> 'DRAFT'
      AND (NEW."carrier_code", NEW."carrier_connection", NEW."carrier_environment", NEW."carrier_account")
          IS DISTINCT FROM (OLD."carrier_code", OLD."carrier_connection", OLD."carrier_environment", OLD."carrier_account"))
     OR (OLD."cancel_requested_at" IS NOT NULL AND NEW."cancel_requested_at" IS DISTINCT FROM OLD."cancel_requested_at"
         AND NEW."status" <> 'CANCELLING')
     OR (OLD."carrier_shipment_ref" IS NOT NULL AND NEW."carrier_shipment_ref" IS DISTINCT FROM OLD."carrier_shipment_ref")
     OR (OLD."labeled_at" IS NOT NULL AND NEW."labeled_at" IS DISTINCT FROM OLD."labeled_at") THEN
    RAISE EXCEPTION 'AYVO: carrier data are recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('REQUESTING', 'CANCELLED'))
    OR (OLD."status" = 'REQUESTING' AND NEW."status" IN ('DRAFT', 'LABELED', 'CANCELLING'))
    OR (OLD."status" = 'LABELED' AND NEW."status" = 'CANCELLING')
    OR (OLD."status" = 'CANCELLING' AND NEW."status" IN ('LABELED', 'REQUESTING', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'AYVO: shipment % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- A shipment created at the carrier is cancelled only when the carrier confirmed it.
  IF OLD."status" = 'CANCELLING' AND NEW."status" = 'CANCELLED' AND NEW."carrier_cancelled_at" IS NULL THEN
    RAISE EXCEPTION 'AYVO: a labelled shipment is cancelled only through the carrier' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'CANCELLED' AND NEW."carrier_cancelled_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a draft shipment was never at the carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;


-- A request belongs to its shipment's carrier — including the account.
CREATE OR REPLACE FUNCTION shipment_carrier_requests_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'PREPARED' THEN
    RAISE EXCEPTION 'AYVO: a carrier request starts PREPARED' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "shipments" s WHERE s."id" = NEW."shipment_id" AND s."status" = 'REQUESTING'
                                               AND s."carrier_code" = NEW."carrier_code"
                                               AND s."carrier_connection" = NEW."carrier_connection"
                                               AND s."carrier_environment" = NEW."carrier_environment"
                                               AND s."carrier_account" IS NOT DISTINCT FROM NEW."carrier_account") THEN
    RAISE EXCEPTION 'AYVO: a carrier request belongs to a requesting shipment of the same carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 2. A verification of a site's settings is valid only for the account it was made with.
ALTER TABLE "site_carrier_settings" ADD COLUMN "verified_account" TEXT;
ALTER TABLE "site_carrier_settings"
  ADD CONSTRAINT "site_carrier_settings_verified_account_check" CHECK (
    ("verified_at" IS NULL) = ("verified_account" IS NULL));

-- 3. Credentials entered in the administration: one row per server-side connection code, the
--    secret only encrypted (AES-256-GCM; the key exists only in the server environment, never in
--    the database). Replaced, never deleted, never read back by the API. Only the TEST environment
--    exists in this stage: a production connection needs its own approved migration.
CREATE TABLE "carrier_connections" (
    "code" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "carrier_connections_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "carrier_connections_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    CONSTRAINT "carrier_connections_carrier_check" CHECK ("carrier" = 'PPL'),
    CONSTRAINT "carrier_connections_environment_check" CHECK ("environment" = 'TEST'),
    CONSTRAINT "carrier_connections_client_id_check" CHECK (length("client_id") BETWEEN 1 AND 200),
    CONSTRAINT "carrier_connections_account_check" CHECK ("account" ~ '^[a-z0-9-]{4,64}$'),
    CONSTRAINT "carrier_connections_secret_check" CHECK (
      octet_length("secret_ciphertext") BETWEEN 1 AND 1024
      AND octet_length("secret_iv") = 12
      AND octet_length("secret_tag") = 16),
    CONSTRAINT "carrier_connections_key_id_check" CHECK ("key_id" ~ '^[0-9a-f]{16}$')
);
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "carrier_connections_no_delete" BEFORE DELETE ON "carrier_connections"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "carrier_connections_no_truncate" BEFORE TRUNCATE ON "carrier_connections"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Permission: managing carrier connections (credentials). ADMIN only, security administration.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('carriers:connections_manage', 'Enter and replace carrier connection credentials (stored encrypted; never shown back)', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'carriers:connections_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
