-- Multi-site foundation, custom roles and site scopes (doc 021, doc 022, ADR 0023), step 2 of 2.
--
-- ADDITIVE: no row is deleted and no business record is rewritten. Existing warehouses and
-- goods receipts are assigned to ONE deterministic initial site ("SITE-1", fixed id below) via
-- column defaults (no UPDATE of immutable rows, no trigger bypass). No stock movement, balance,
-- receipt, lot or ledger event is created. Existing warehouse scopes keep their meaning: each
-- user holding one also gets the matching site scope (audited as a migration action).

-- =============================================================================================
-- Sites
-- =============================================================================================

CREATE TYPE "SiteCapability" AS ENUM ('WAREHOUSE', 'PRODUCTION', 'RETURNS');

CREATE TABLE "sites" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "city" TEXT,
    "time_zone" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL,
    "default_currency" CHAR(3) NOT NULL,
    "capabilities" "SiteCapability"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "deactivated_at" TIMESTAMPTZ(3),

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sites_code_key" ON "sites"("code");
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sites" ADD CONSTRAINT "sites_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sites"
  ADD CONSTRAINT "sites_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9-]{1,19}$'),
  ADD CONSTRAINT "sites_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "sites_country_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "sites_locale_check" CHECK ("default_locale" ~ '^[a-z]{2}-[A-Z]{2}$'),
  ADD CONSTRAINT "sites_currency_check" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "sites_capabilities_check" CHECK (
    "capabilities" IS NOT NULL AND array_position("capabilities", NULL) IS NULL),
  -- The address is complete or (only for the migrated initial site) not yet filled in.
  ADD CONSTRAINT "sites_address_check" CHECK (
    ("address_line1" IS NULL) = ("city" IS NULL) AND ("city" IS NULL) = ("postal_code" IS NULL)
    AND ("address_line1" IS NOT NULL OR "address_line2" IS NULL)
    AND coalesce(length(btrim("address_line1")), 1) BETWEEN 1 AND 200
    AND coalesce(length(btrim("city")), 1) BETWEEN 1 AND 120
    AND coalesce(length(btrim("postal_code")), 1) BETWEEN 1 AND 20),
  ADD CONSTRAINT "sites_deactivation_check" CHECK ("active" = ("deactivated_at" IS NULL));

-- A site is never deleted; its code and id never change; the time zone must be a real IANA zone.
CREATE FUNCTION sites_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."id" <> OLD."id" OR NEW."code" <> OLD."code"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" IS DISTINCT FROM OLD."created_by") THEN
    RAISE EXCEPTION 'AYVO: site id, code and creation are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE "name" = NEW."time_zone")
     OR NEW."time_zone" !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$' THEN
    RAISE EXCEPTION 'AYVO: unknown IANA time zone %', NEW."time_zone" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sites_guard" BEFORE INSERT OR UPDATE ON "sites"
  FOR EACH ROW EXECUTE FUNCTION sites_guard();
CREATE TRIGGER "sites_no_delete" BEFORE DELETE ON "sites"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sites_no_truncate" BEFORE TRUNCATE ON "sites"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- The initial site that owns everything that exists today. Its address is left for the
-- administrator to complete (doc 022 §9); country, time zone, locale and currency are those the
-- application has used so far (Czech UI, Europe/Prague, CZK).
INSERT INTO "sites" ("id", "code", "name", "country_code", "time_zone", "default_locale",
                     "default_currency", "capabilities")
VALUES ('01990000-0000-7000-8000-000000000001', 'SITE-1', 'Výchozí provozovna', 'CZ',
        'Europe/Prague', 'cs-CZ', 'CZK', ARRAY['WAREHOUSE', 'PRODUCTION']::"SiteCapability"[]);

-- Audit events name the site a site-specific event concerns.
ALTER TABLE "audit_events" ADD COLUMN "site_id" UUID;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "audit_events_site_id_occurred_at_idx" ON "audit_events"("site_id", "occurred_at");

-- =============================================================================================
-- Warehouses and receipts belong to a site (defaults assign existing rows without UPDATEs)
-- =============================================================================================

ALTER TABLE "inventory_locations"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001',
  ADD COLUMN "is_site_default" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "inventory_locations" ALTER COLUMN "site_id" DROP DEFAULT,
  ALTER COLUMN "is_site_default" SET DEFAULT false;
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "inventory_locations_one_default_per_site" ON "inventory_locations" ("site_id")
  WHERE "is_site_default";

ALTER TABLE "goods_receipts"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001';
ALTER TABLE "goods_receipts" ALTER COLUMN "site_id" DROP DEFAULT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "goods_receipts_site_id_received_at_idx" ON "goods_receipts"("site_id", "received_at");

-- =============================================================================================
-- Catalogue guard: system roles and permissions change only inside a reviewed migration
-- =============================================================================================

-- Migrations that change the catalogue switch `ayvo.catalogue_migration` on for their own
-- connection (`set_config(…, 'on', false)`) and off again at the end; Prisma does not wrap a
-- migration in one transaction, so a transaction-local setting would not last. The application
-- never sets it.
CREATE FUNCTION ayvo_catalogue_migration() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('ayvo.catalogue_migration', true), '') = 'on' $$;

SELECT set_config('ayvo.catalogue_migration', 'on', false);

-- --- Permissions ---------------------------------------------------------------------------

ALTER TABLE "permissions" ADD COLUMN "security_admin" BOOLEAN NOT NULL DEFAULT false;
DROP TRIGGER "permissions_immutable" ON "permissions";
CREATE FUNCTION permissions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT ayvo_catalogue_migration() THEN
    RAISE EXCEPTION 'AYVO: the permission catalogue changes only by migration' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: permissions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "permissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION permissions_guard();
ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_code_check" CHECK ("code" ~ '^[a-z]+:[a-z_]+$');

UPDATE "permissions" SET "security_admin" = true WHERE "code" LIKE 'identity:%';

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin") VALUES
  ('identity:roles_manage', 'Create, edit, duplicate and deactivate custom roles', false, true),
  ('sites:manage', 'Create and edit sites (facilities), their capabilities and activation', false, true),
  ('sites:all_access', 'Global access to every site and warehouse (evaluated explicitly; ADMIN)', false, true);

-- --- Roles ---------------------------------------------------------------------------------

-- Existing rows are the system roles: is_system is added with DEFAULT true, then defaults to
-- false for custom roles created later.
ALTER TABLE "roles"
  ADD COLUMN "id" UUID NOT NULL DEFAULT uuidv7(),
  ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_by" UUID,
  ADD COLUMN "deactivated_at" TIMESTAMPTZ(3);
ALTER TABLE "roles" ALTER COLUMN "is_system" SET DEFAULT false;
CREATE UNIQUE INDEX "roles_id_key" ON "roles"("id");
ALTER TABLE "roles" ADD CONSTRAINT "roles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  ADD CONSTRAINT "roles_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "roles_description_check" CHECK (length("description") <= 500),
  ADD CONSTRAINT "roles_deactivation_check" CHECK ("active" = ("deactivated_at" IS NULL)),
  ADD CONSTRAINT "roles_system_active_check" CHECK (NOT "is_system" OR "active");

DROP TRIGGER "roles_immutable" ON "roles";
CREATE FUNCTION roles_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: roles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."is_system" AND NOT ayvo_catalogue_migration() THEN
      RAISE EXCEPTION 'AYVO: system roles are created only by migration' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."is_system" AND NOT ayvo_catalogue_migration() THEN
    RAISE EXCEPTION 'AYVO: system roles change only by migration' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."code" <> OLD."code" OR NEW."id" <> OLD."id" OR NEW."is_system" <> OLD."is_system"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
    RAISE EXCEPTION 'AYVO: role code, id, kind and creation are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."active" AND NOT NEW."active" AND EXISTS (
       SELECT 1 FROM "user_roles" WHERE "role_code" = OLD."code" AND "revoked_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a role still assigned to users cannot be deactivated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "roles_guard" BEFORE INSERT OR UPDATE OR DELETE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION roles_guard();

-- --- Role permissions ----------------------------------------------------------------------

DROP TRIGGER "role_permissions_immutable" ON "role_permissions";
CREATE FUNCTION role_permissions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  role_code text := CASE WHEN TG_OP = 'DELETE' THEN OLD."role_code" ELSE NEW."role_code" END;
  system_role boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AYVO: role permissions are added or removed, never rewritten' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "is_system" INTO system_role FROM "roles" WHERE "code" = role_code;
  IF system_role AND NOT ayvo_catalogue_migration() THEN
    RAISE EXCEPTION 'AYVO: system role permissions change only by migration' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT system_role AND EXISTS (
       SELECT 1 FROM "permissions" WHERE "code" = NEW."permission_code" AND "security_admin") THEN
    RAISE EXCEPTION 'AYVO: a custom role cannot hold a security-administration permission'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER "role_permissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION role_permissions_guard();

-- Only ADMIN holds security administration, and ADMIN holds every permission explicitly.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'identity:roles_manage'),
  ('ADMIN', 'sites:manage'),
  ('ADMIN', 'sites:all_access');

UPDATE "roles" SET "description" = 'Sees and manages the whole system: every permission, global site access'
  WHERE "code" = 'ADMIN';

SELECT set_config('ayvo.catalogue_migration', 'off', false);

-- --- Grants: an inactive role cannot be granted ----------------------------------------------

CREATE FUNCTION user_roles_active_role() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "roles" WHERE "code" = NEW."role_code" AND "active") THEN
    RAISE EXCEPTION 'AYVO: an inactive role cannot be granted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_roles_active_role" BEFORE INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION user_roles_active_role();

-- =============================================================================================
-- Scopes: site access, warehouses narrow a site
-- =============================================================================================

ALTER TABLE "user_scopes" ADD COLUMN "site_id" UUID;
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_scopes" DROP CONSTRAINT "user_scopes_target_check";
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_target_check" CHECK (
  ("type" = 'SITE') = ("site_id" IS NOT NULL)
  AND ("type" = 'WAREHOUSE') = ("location_id" IS NOT NULL)
  AND ("type" IN ('HOTEL_ORGANIZATION', 'HOTEL_SITE')) = ("scope_ref" IS NOT NULL));
CREATE UNIQUE INDEX "user_scopes_one_open_site" ON "user_scopes" ("user_id", "site_id")
  WHERE "revoked_at" IS NULL AND "type" = 'SITE';
DROP INDEX "user_scopes_one_open_hotel";
CREATE UNIQUE INDEX "user_scopes_one_open_hotel" ON "user_scopes" ("user_id", "type", "scope_ref")
  WHERE "revoked_at" IS NULL AND "type" IN ('HOTEL_ORGANIZATION', 'HOTEL_SITE');

-- Existing warehouse access keeps its meaning: the user also gets the warehouse's site.
WITH migrated AS (
  INSERT INTO "user_scopes" ("user_id", "type", "site_id")
  SELECT DISTINCT s."user_id", 'SITE'::"ScopeType", l."site_id"
  FROM "user_scopes" s JOIN "inventory_locations" l ON l."id" = s."location_id"
  WHERE s."type" = 'WAREHOUSE' AND s."revoked_at" IS NULL
  RETURNING "user_id", "site_id"
)
INSERT INTO "audit_events" ("type", "target_user_id", "reason", "payload", "site_id")
SELECT 'SCOPE_GRANTED', "user_id", 'Migration: site access derived from existing warehouse access',
       jsonb_build_object('site', 'SITE-1', 'migration', '20261012120100_sites_and_custom_roles'),
       "site_id"
FROM migrated;

-- A warehouse scope needs an open scope of the warehouse's site; a site scope is revoked only
-- after its warehouse scopes.
CREATE FUNCTION user_scopes_site_consistency() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."type" = 'WAREHOUSE' AND NOT EXISTS (
       SELECT 1 FROM "user_scopes" s JOIN "inventory_locations" l ON l."site_id" = s."site_id"
       WHERE l."id" = NEW."location_id" AND s."user_id" = NEW."user_id"
         AND s."type" = 'SITE' AND s."revoked_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: warehouse access needs access to its site' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."type" = 'SITE' AND OLD."revoked_at" IS NULL
     AND NEW."revoked_at" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "user_scopes" s JOIN "inventory_locations" l ON l."id" = s."location_id"
       WHERE l."site_id" = NEW."site_id" AND s."user_id" = NEW."user_id"
         AND s."type" = 'WAREHOUSE' AND s."revoked_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: revoke the warehouses of a site before the site' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_scopes_site_consistency" BEFORE INSERT OR UPDATE ON "user_scopes"
  FOR EACH ROW EXECUTE FUNCTION user_scopes_site_consistency();

-- =============================================================================================
-- Sessions remember the active site
-- =============================================================================================

ALTER TABLE "user_sessions" ADD COLUMN "active_site_id" UUID;
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_site_id_fkey" FOREIGN KEY ("active_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION user_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoke_reason', 'active_site_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoke_reason', 'active_site_id'])
     OR (OLD."revoked_at" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'AYVO: a session can only record activity and its site, and be revoked once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
