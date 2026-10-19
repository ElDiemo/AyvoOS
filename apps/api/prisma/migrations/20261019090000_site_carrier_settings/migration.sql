-- Carrier settings per site (doc 029 §9, doc 022 §8; owner 2026-10-19): PPL only. Additive: one
-- new table and one permission. No secret is stored here — only the name of a server-side
-- connection; credentials stay in the server's protected environment.

-- CreateTable
CREATE TABLE "site_carrier_settings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "site_id" UUID NOT NULL,
    "carrier" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "connection" TEXT,
    "sender_name" TEXT,
    "sender_street" TEXT,
    "sender_city" TEXT,
    "sender_postal_code" TEXT,
    "sender_country" CHAR(2),
    "sender_contact" TEXT,
    "sender_phone" TEXT,
    "sender_email" TEXT,
    "product_code" TEXT,
    "label_format" TEXT NOT NULL DEFAULT 'PDF',
    "label_dpi" INTEGER NOT NULL DEFAULT 203,
    "label_layout" TEXT NOT NULL DEFAULT 'SINGLE',
    "verified_at" TIMESTAMPTZ(3),
    "verified_by" UUID,
    "verified_connection" TEXT,
    "verified_products" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "site_carrier_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_carrier_settings_site_id_key" ON "site_carrier_settings"("site_id");

-- AddForeignKey
ALTER TABLE "site_carrier_settings" ADD CONSTRAINT "site_carrier_settings_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_carrier_settings" ADD CONSTRAINT "site_carrier_settings_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_carrier_settings" ADD CONSTRAINT "site_carrier_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "site_carrier_settings"
  ADD CONSTRAINT "site_carrier_settings_carrier_check" CHECK ("carrier" = 'PPL'),
  ADD CONSTRAINT "site_carrier_settings_connection_check" CHECK ("connection" IS NULL OR "connection" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  ADD CONSTRAINT "site_carrier_settings_country_check" CHECK ("sender_country" IS NULL OR "sender_country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "site_carrier_settings_label_check" CHECK (
    "label_format" IN ('PDF', 'ZPL') AND "label_dpi" BETWEEN 203 AND 1200 AND "label_layout" IN ('SINGLE', 'A4')),
  ADD CONSTRAINT "site_carrier_settings_verified_check" CHECK (
    ("verified_at" IS NULL) = ("verified_by" IS NULL)
    AND ("verified_at" IS NULL) = ("verified_connection" IS NULL)),
  ADD CONSTRAINT "site_carrier_settings_lengths_check" CHECK (
    coalesce(length("sender_name"), 0) <= 50 AND coalesce(length("sender_street"), 0) <= 60
    AND coalesce(length("sender_city"), 0) <= 50 AND coalesce(length("sender_postal_code"), 0) <= 10
    AND coalesce(length("sender_contact"), 0) <= 50 AND coalesce(length("sender_phone"), 0) <= 30
    AND coalesce(length("sender_email"), 0) <= 50 AND coalesce(length("product_code"), 0) <= 20);

CREATE TRIGGER "site_carrier_settings_no_delete" BEFORE DELETE ON "site_carrier_settings"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "site_carrier_settings_no_truncate" BEFORE TRUNCATE ON "site_carrier_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Permission: site administration of carriers (and the connection check). ADMIN only: marked as
-- security administration, so a custom role can never hold it.
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('sites:carrier_manage', 'View and change the carrier settings of sites (PPL) and verify the carrier connection; never shows credentials', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'sites:carrier_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
