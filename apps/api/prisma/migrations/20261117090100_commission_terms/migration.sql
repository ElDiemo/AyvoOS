-- Sales commissions PR 1a — the commission terms of a salesperson (doc 068 §3.1, ADR 0046 §2a).
-- PROTOTYPE: the model waits for the owner's approval; this migration has run only in the per-run
-- test databases, never on DEV.
--
-- Owner, 2026-11-16: in Obchod → Provize → Nastavení the owner / an admin sets, per salesperson,
-- the initial rate %, its length N in whole months and the maintenance rate % (from month N+1).
-- The salesperson reads their own terms only. Versions are append-only; the newest is the valid
-- version. A new version never touches hotels already bound (PR 1b). Additive: no existing table,
-- trigger or constraint changes (doc 068 §8.2).

-- --- The permission: ADMIN only, never a custom role (doc 068 §8.1) ----------------------------
-- `security_admin` makes role_permissions_guard refuse it in every non-system role, as for
-- identity:portal_grants_manage.

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('sales:commission_terms_manage', 'Obchod: set the commission terms of salespeople (initial rate, its length, maintenance rate) and read everyone''s terms', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'sales:commission_terms_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);

-- --- The terms versions ------------------------------------------------------------------------

CREATE TABLE "sales_commission_terms" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "salesperson_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "initial_rate" NUMERIC NOT NULL,
    "initial_months" INTEGER NOT NULL,
    "maintenance_rate" NUMERIC NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "recorded_by" UUID NOT NULL,
    "request_id" UUID NOT NULL,

    CONSTRAINT "sales_commission_terms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_commission_terms_version_check" CHECK ("version" >= 1),
    -- Exact, 0–100 %, at most 2 decimals: refused, never rounded. 0.00 is an explicit rate.
    CONSTRAINT "sales_commission_terms_initial_rate_check"
      CHECK ("initial_rate" >= 0 AND "initial_rate" <= 100 AND scale("initial_rate") <= 2),
    CONSTRAINT "sales_commission_terms_maintenance_rate_check"
      CHECK ("maintenance_rate" >= 0 AND "maintenance_rate" <= 100 AND scale("maintenance_rate") <= 2),
    -- Whole months, at least one. No upper bound is invented (doc 068 Q12).
    CONSTRAINT "sales_commission_terms_initial_months_check" CHECK ("initial_months" >= 1),
    CONSTRAINT "sales_commission_terms_reason_check" CHECK (btrim("reason") <> '')
);

CREATE UNIQUE INDEX "sales_commission_terms_salesperson_version_key"
  ON "sales_commission_terms"("salesperson_id", "version");
CREATE UNIQUE INDEX "sales_commission_terms_request_id_key" ON "sales_commission_terms"("request_id");

ALTER TABLE "sales_commission_terms" ADD CONSTRAINT "sales_commission_terms_salesperson_id_fkey"
  FOREIGN KEY ("salesperson_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_commission_terms" ADD CONSTRAINT "sales_commission_terms_recorded_by_fkey"
  FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Versions follow each other without gaps per salesperson (the service holds the advisory lock
-- `sales-terms:<salesperson>` and checks expectedVersion; this is the database's own guard).
CREATE FUNCTION sales_commission_terms_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."version" <> COALESCE((SELECT max("version") FROM "sales_commission_terms"
                                 WHERE "salesperson_id" = NEW."salesperson_id"), 0) + 1 THEN
    RAISE EXCEPTION 'AYVO: commission terms versions follow each other' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_commission_terms_insert" BEFORE INSERT ON "sales_commission_terms"
  FOR EACH ROW EXECUTE FUNCTION sales_commission_terms_insert();
-- History is append-only (ADR 0006): a change of terms is a new version, never an update.
CREATE TRIGGER "sales_commission_terms_immutable" BEFORE UPDATE OR DELETE ON "sales_commission_terms"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_commission_terms_no_truncate" BEFORE TRUNCATE ON "sales_commission_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
