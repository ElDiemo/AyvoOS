-- Hotel portal PR 2 (ADR 0045 §4 on `0d500f6`, owner 2026-11-07, #127 comment 6711432652): portal
-- grants — which payer (a Finance customer id, opaque to the core) and which of its hotels one hotel
-- portal (PORTAL) account may see. Finance checks the pair and then calls the core's contract; the
-- core stores the grant and is its authority. A grant is never edited and never revived: a change
-- of scope is a new grant that replaces the old one (revoked in the same transaction), and
-- revocation only sets `revoked_*`. Nothing here is visible to anyone yet (the portal comes later).

-- --- The permission (ADMIN only; security administration — never a custom role) ---------------

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('identity:portal_grants_manage', 'Hotel portal: grant a hotel portal account access to a payer and its hotels (issued and replaced through Finance), and revoke it', false, true, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'identity:portal_grants_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);

-- --- Tables ------------------------------------------------------------------------------------

CREATE TABLE "portal_grants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "payer_customer_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "finance_check" JSONB NOT NULL,
    "replaces_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason" TEXT,

    CONSTRAINT "portal_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "portal_grants_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "portal_grants_finance_check_check" CHECK (jsonb_typeof("finance_check") = 'object'),
    CONSTRAINT "portal_grants_revoked_check" CHECK (
      ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
      AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
      AND ("revoke_reason" IS NULL OR btrim("revoke_reason") <> '')),
    CONSTRAINT "portal_grants_replaces_check" CHECK ("replaces_id" IS DISTINCT FROM "id")
);

CREATE TABLE "portal_grant_hotels" (
    "grant_id" UUID NOT NULL,
    "hotel_id" UUID NOT NULL,

    CONSTRAINT "portal_grant_hotels_pkey" PRIMARY KEY ("grant_id","hotel_id")
);

-- A grant is replaced at most once.
CREATE UNIQUE INDEX "portal_grants_replaces_id_key" ON "portal_grants"("replaces_id");
CREATE INDEX "portal_grants_payer_customer_id_idx" ON "portal_grants"("payer_customer_id");
CREATE INDEX "portal_grant_hotels_hotel_id_idx" ON "portal_grant_hotels"("hotel_id");

-- At most one active grant per (user, payer): the scope is never composed from several grants.
CREATE UNIQUE INDEX "portal_grants_one_active" ON "portal_grants" ("user_id", "payer_customer_id")
  WHERE "revoked_at" IS NULL;

ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_replaces_id_fkey" FOREIGN KEY ("replaces_id") REFERENCES "portal_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_grant_hotels" ADD CONSTRAINT "portal_grant_hotels_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "portal_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "portal_grant_hotels" ADD CONSTRAINT "portal_grant_hotels_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- A new grant: a PORTAL account, active, a replacement only of its own revoked predecessor ----

CREATE FUNCTION portal_grants_insert_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  aud "AccountAudience";
  old "portal_grants"%ROWTYPE;
BEGIN
  -- The fixed lock order of the account: the user row first (as for role grants).
  SELECT "audience" INTO aud FROM "users" WHERE "id" = NEW."user_id" FOR UPDATE;
  IF aud IS DISTINCT FROM 'PORTAL' THEN
    RAISE EXCEPTION 'AYVO: a portal grant is only for a PORTAL account' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a portal grant starts active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."replaces_id" IS NOT NULL THEN
    SELECT * INTO old FROM "portal_grants" WHERE "id" = NEW."replaces_id";
    -- The predecessor of the same user and payer, revoked by this very transaction.
    IF NOT FOUND OR old."user_id" <> NEW."user_id" OR old."payer_customer_id" <> NEW."payer_customer_id"
       OR old."revoked_at" IS NULL OR old.xmin <> pg_current_xact_id()::xid THEN
      RAISE EXCEPTION 'AYVO: a portal grant replaces only its own predecessor, revoked in the same transaction'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "portal_grants_insert_rules" BEFORE INSERT ON "portal_grants"
  FOR EACH ROW EXECUTE FUNCTION portal_grants_insert_rules();

-- --- Never edited, never revived, never deleted ---------------------------------------------------

CREATE FUNCTION portal_grants_update_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a revoked portal grant never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."user_id" <> OLD."user_id"
     OR NEW."payer_customer_id" <> OLD."payer_customer_id" OR NEW."granted_at" <> OLD."granted_at"
     OR NEW."granted_by" <> OLD."granted_by" OR NEW."reason" <> OLD."reason"
     OR NEW."finance_check" <> OLD."finance_check"
     OR NEW."replaces_id" IS DISTINCT FROM OLD."replaces_id" THEN
    RAISE EXCEPTION 'AYVO: a portal grant is never edited; a change of scope is a new grant'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "portal_grants_update_rules" BEFORE UPDATE ON "portal_grants"
  FOR EACH ROW EXECUTE FUNCTION portal_grants_update_rules();

CREATE FUNCTION portal_grants_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'AYVO: portal grants are history; revoke instead of deleting' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER "portal_grants_no_delete" BEFORE DELETE ON "portal_grants"
  FOR EACH ROW EXECUTE FUNCTION portal_grants_no_delete();
CREATE TRIGGER "portal_grant_hotels_no_change" BEFORE UPDATE OR DELETE ON "portal_grant_hotels"
  FOR EACH ROW EXECUTE FUNCTION portal_grants_no_delete();

-- --- The hotel set: written with its grant, in the same transaction, never empty ------------------

CREATE FUNCTION portal_grant_hotels_insert_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  g "portal_grants"%ROWTYPE;
BEGIN
  SELECT * INTO g FROM "portal_grants" WHERE "id" = NEW."grant_id";
  IF NOT FOUND OR g.xmin <> pg_current_xact_id()::xid OR g."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: the hotels of a portal grant are written with the grant'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "portal_grant_hotels_insert_rules" BEFORE INSERT ON "portal_grant_hotels"
  FOR EACH ROW EXECUTE FUNCTION portal_grant_hotels_insert_rules();

CREATE FUNCTION portal_grants_have_hotels() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "portal_grant_hotels" WHERE "grant_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a portal grant names at least one hotel' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "portal_grants_have_hotels" AFTER INSERT ON "portal_grants"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION portal_grants_have_hotels();
