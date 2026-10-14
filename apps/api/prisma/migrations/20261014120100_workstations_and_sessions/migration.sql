-- Workstations and work sessions (doc 026, issue #19 A2; model approved by the owner 2026-10-14).
-- Additive: new tables, the QR registry trigger function extended to stations, new permissions
-- and their grants (doc 025 §13 B4). No existing row changes; no station or session is created.

-- CreateEnum
CREATE TYPE "WorkstationMode" AS ENUM ('LABELING', 'FILLING');

-- CreateEnum
CREATE TYPE "WorkstationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WorkstationEventType" AS ENUM ('CREATED', 'DEACTIVATED', 'REACTIVATED');

-- CreateEnum
CREATE TYPE "WorkstationSessionStatus" AS ENUM ('ACTIVE', 'RELEASED', 'TAKEN_OVER', 'CLOSED');

-- CreateEnum
CREATE TYPE "WorkstationSessionEventType" AS ENUM ('OPENED', 'RESUMED', 'RELEASED', 'TAKEN_OVER', 'CLOSED');


-- CreateTable
CREATE TABLE "workstations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "mode" "WorkstationMode" NOT NULL,
    "category_code" TEXT,
    "status" "WorkstationStatus" NOT NULL DEFAULT 'ACTIVE',
    "qr_token" TEXT NOT NULL,
    "qr_kind" "QrIdentityKind" NOT NULL DEFAULT 'WORKSTATION',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "workstations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstation_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workstation_id" UUID NOT NULL,
    "type" "WorkstationEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "reason" TEXT,

    CONSTRAINT "workstation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstation_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workstation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "WorkstationSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "close_reason" TEXT,

    CONSTRAINT "workstation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstation_session_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "session_id" UUID NOT NULL,
    "type" "WorkstationSessionEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "reason" TEXT,

    CONSTRAINT "workstation_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workstations_code_key" ON "workstations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_qr_token_key" ON "workstations"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_operation_request_id_key" ON "workstations"("operation_request_id");

-- CreateIndex
CREATE INDEX "workstations_site_id_code_idx" ON "workstations"("site_id", "code");

-- CreateIndex
CREATE INDEX "workstation_events_workstation_id_occurred_at_idx" ON "workstation_events"("workstation_id", "occurred_at");

-- CreateIndex
CREATE INDEX "workstation_sessions_user_id_opened_at_idx" ON "workstation_sessions"("user_id", "opened_at");

-- CreateIndex
CREATE INDEX "workstation_session_events_session_id_occurred_at_idx" ON "workstation_session_events"("session_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "product_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_qr_token_qr_kind_fkey" FOREIGN KEY ("qr_token", "qr_kind") REFERENCES "qr_identities"("token", "kind") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_events" ADD CONSTRAINT "workstation_events_workstation_id_fkey" FOREIGN KEY ("workstation_id") REFERENCES "workstations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_events" ADD CONSTRAINT "workstation_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_events" ADD CONSTRAINT "workstation_events_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_workstation_id_fkey" FOREIGN KEY ("workstation_id") REFERENCES "workstations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_session_events" ADD CONSTRAINT "workstation_session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "workstation_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_session_events" ADD CONSTRAINT "workstation_session_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_session_events" ADD CONSTRAINT "workstation_session_events_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- QR registry: stations register their token like bottles and crates (one token, one kind).
-- =============================================================================================

CREATE OR REPLACE FUNCTION qr_identity_register() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'bottles' THEN
    INSERT INTO "qr_identities" ("token", "kind") VALUES (NEW."public_token", 'BOTTLE');
  ELSIF TG_TABLE_NAME = 'crates' THEN
    INSERT INTO "qr_identities" ("token", "kind") VALUES (NEW."qr_token", 'CRATE');
  ELSE
    INSERT INTO "qr_identities" ("token", "kind") VALUES (NEW."qr_token", 'WORKSTATION');
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Workstations
-- =============================================================================================

ALTER TABLE "workstations"
  ADD CONSTRAINT "workstations_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  ADD CONSTRAINT "workstations_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "workstations_qr_kind_check" CHECK ("qr_kind" = 'WORKSTATION'),
  -- A filling station fills exactly one product category; a labelling station none.
  ADD CONSTRAINT "workstations_category_check"
    CHECK (("mode" = 'FILLING') = ("category_code" IS NOT NULL));

CREATE FUNCTION workstations_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "inventory_locations" l
                  WHERE l."id" = NEW."location_id" AND l."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: a workstation''s warehouse belongs to its site' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'AYVO: a workstation is created active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Only the status changes after creation (with its event, checked at commit).
CREATE FUNCTION workstations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: workstations are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'AYVO: workstation identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The current status always matches the latest station event (CREATED/REACTIVATED ⇒ ACTIVE,
-- DEACTIVATED ⇒ INACTIVE): no status change without its audited event.
CREATE FUNCTION workstations_status_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  latest "WorkstationEventType";
BEGIN
  SELECT e."type" INTO latest FROM "workstation_events" e
   WHERE e."workstation_id" = NEW."id" ORDER BY e."occurred_at" DESC, e."id" DESC LIMIT 1;
  IF latest IS NULL
     OR (NEW."status" = 'ACTIVE' AND latest = 'DEACTIVATED')
     OR (NEW."status" = 'INACTIVE' AND latest <> 'DEACTIVATED') THEN
    RAISE EXCEPTION 'AYVO: workstation % status % has no matching event', NEW."code", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "workstations_insert_check" BEFORE INSERT ON "workstations"
  FOR EACH ROW EXECUTE FUNCTION workstations_insert_check();
CREATE TRIGGER "workstations_qr_identity" BEFORE INSERT ON "workstations"
  FOR EACH ROW EXECUTE FUNCTION qr_identity_register();
CREATE TRIGGER "workstations_guard" BEFORE UPDATE OR DELETE ON "workstations"
  FOR EACH ROW EXECUTE FUNCTION workstations_guard();
CREATE TRIGGER "workstations_no_truncate" BEFORE TRUNCATE ON "workstations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "workstations_status_has_event" AFTER INSERT OR UPDATE OF "status" ON "workstations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workstations_status_has_event();

ALTER TABLE "workstation_events"
  ADD CONSTRAINT "workstation_events_reason_check"
    CHECK ("type" = 'CREATED' OR length(btrim(coalesce("reason", ''))) >= 3);
CREATE TRIGGER "workstation_events_immutable" BEFORE UPDATE OR DELETE ON "workstation_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "workstation_events_no_truncate" BEFORE TRUNCATE ON "workstation_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Work sessions: one ACTIVE per station and per user; ACTIVE → ended once, with its event.
-- =============================================================================================

CREATE UNIQUE INDEX "workstation_sessions_one_active_per_station"
  ON "workstation_sessions" ("workstation_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "workstation_sessions_one_active_per_user"
  ON "workstation_sessions" ("user_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "workstation_sessions"
  ADD CONSTRAINT "workstation_sessions_closed_check"
    CHECK (("status" = 'ACTIVE') = ("closed_at" IS NULL AND "closed_by" IS NULL)),
  ADD CONSTRAINT "workstation_sessions_reason_check"
    CHECK ("status" NOT IN ('TAKEN_OVER', 'CLOSED') OR length(btrim(coalesce("close_reason", ''))) >= 3);

CREATE FUNCTION workstation_sessions_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'AYVO: a work session starts active' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "workstations" w
                  WHERE w."id" = NEW."workstation_id" AND w."site_id" = NEW."site_id" AND w."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'AYVO: a work session needs an active workstation of its site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION workstation_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: work sessions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'AYVO: an ended work session never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."workstation_id" IS DISTINCT FROM OLD."workstation_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
     OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at" THEN
    RAISE EXCEPTION 'AYVO: work session identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Every session opening and ending has its event of the same kind (checked at commit).
CREATE FUNCTION workstation_sessions_have_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  needed "WorkstationSessionEventType";
BEGIN
  needed := CASE NEW."status" WHEN 'ACTIVE' THEN 'OPENED' ELSE NEW."status"::text END::"WorkstationSessionEventType";
  IF NOT EXISTS (SELECT 1 FROM "workstation_session_events" e
                  WHERE e."session_id" = NEW."id" AND e."type" = needed) THEN
    RAISE EXCEPTION 'AYVO: work session % (%) has no % event', NEW."id", NEW."status", needed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "workstation_sessions_insert_check" BEFORE INSERT ON "workstation_sessions"
  FOR EACH ROW EXECUTE FUNCTION workstation_sessions_insert_check();
CREATE TRIGGER "workstation_sessions_guard" BEFORE UPDATE OR DELETE ON "workstation_sessions"
  FOR EACH ROW EXECUTE FUNCTION workstation_sessions_guard();
CREATE TRIGGER "workstation_sessions_no_truncate" BEFORE TRUNCATE ON "workstation_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "workstation_sessions_have_event"
  AFTER INSERT OR UPDATE OF "status" ON "workstation_sessions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workstation_sessions_have_event();

ALTER TABLE "workstation_session_events"
  ADD CONSTRAINT "workstation_session_events_reason_check"
    CHECK ("type" NOT IN ('TAKEN_OVER', 'CLOSED') OR length(btrim(coalesce("reason", ''))) >= 3);
CREATE TRIGGER "workstation_session_events_immutable" BEFORE UPDATE OR DELETE ON "workstation_session_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "workstation_session_events_no_truncate" BEFORE TRUNCATE ON "workstation_session_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Permissions (doc 025 §7 / §13 B4, approved 2026-10-14). Station work acts in the station's
-- warehouse; management and forced takeover at the active site. The operator's labelling
-- permission (production:label_apply) is granted with the labelling station (A3), together with
-- retiring the standalone label application — not here. ADMIN holds every permission (doc 021).
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('production:workstations_manage', 'Create, deactivate and reactivate workstations of the site and print their QR labels', false, false, true, 'PRODUCTION'),
  ('production:fill', 'Work at a filling station of the site (filling, liquid lot switch, Hotovo)', true, false, false, 'PRODUCTION'),
  ('production:session_takeover', 'Forcibly take over a workstation occupied by another user (reason required)', false, false, true, 'PRODUCTION');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'production:workstations_manage'),
  ('ADMIN', 'production:fill'),
  ('ADMIN', 'production:session_takeover'),
  ('PRODUCTION_SUPERVISOR', 'production:workstations_manage'),
  ('PRODUCTION_SUPERVISOR', 'production:fill'),
  ('PRODUCTION_SUPERVISOR', 'production:session_takeover'),
  ('PRODUCTION_OPERATOR', 'production:fill');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
