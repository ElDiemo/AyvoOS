-- Obchod — hotel acquisition (doc 034, ADR 0031). Additive: new tables, two permissions, the SALES
-- role becomes the Obchod role (its planning stock permission is removed). Nothing outside Obchod
-- is read or written by these tables.

-- ---------------------------------------------------------------------------------------------
-- 1. Prospects (current state; every change is a sales_events row in the same transaction)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "sales_prospects" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Normalised name / website domain for the duplicate warning (set by the application).
    "name_key" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "city" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    -- An estimate, never a contracted number; unknown is NULL, never 0.
    "rooms_estimate" INTEGER,
    "accommodation_type" TEXT,
    "website" TEXT,
    "website_key" TEXT,
    "source" TEXT,
    "owner_id" UUID NOT NULL,
    "priority" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "lost_reason" TEXT,
    "note" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "sales_prospects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_prospects_serial_check" CHECK ("serial" >= 1),
    CONSTRAINT "sales_prospects_code_check" CHECK ("code" = ayvo_format_code('AKV-', "serial")),
    CONSTRAINT "sales_prospects_name_check" CHECK (btrim("name") <> '' AND length("name") <= 200 AND "name_key" <> ''),
    CONSTRAINT "sales_prospects_country_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
    CONSTRAINT "sales_prospects_optional_text_check" CHECK (
      ("city" IS NULL OR (btrim("city") <> '' AND length("city") <= 120))
      AND ("address_line1" IS NULL OR (btrim("address_line1") <> '' AND length("address_line1") <= 200))
      AND ("address_line2" IS NULL OR (btrim("address_line2") <> '' AND length("address_line2") <= 200))
      AND ("postal_code" IS NULL OR (btrim("postal_code") <> '' AND length("postal_code") <= 20))
      AND ("website" IS NULL OR (btrim("website") <> '' AND length("website") <= 300))
      AND ("source" IS NULL OR (btrim("source") <> '' AND length("source") <= 200))
      AND ("note" IS NULL OR (btrim("note") <> '' AND length("note") <= 4000))),
    CONSTRAINT "sales_prospects_rooms_check" CHECK ("rooms_estimate" IS NULL OR "rooms_estimate" BETWEEN 1 AND 100000),
    CONSTRAINT "sales_prospects_type_check" CHECK (
      "accommodation_type" IS NULL OR "accommodation_type" IN ('HOTEL', 'PENSION', 'APARTMENTS', 'HOSTEL', 'OTHER')),
    CONSTRAINT "sales_prospects_priority_check" CHECK ("priority" IS NULL OR "priority" IN ('A', 'B', 'C')),
    CONSTRAINT "sales_prospects_stage_check" CHECK (
      "stage" IN ('NEW', 'CONTACTED', 'NEGOTIATION', 'OFFER', 'WON', 'LOST')),
    -- The reason of a lost deal exists exactly while the stage is LOST.
    CONSTRAINT "sales_prospects_lost_check" CHECK (
      ("stage" = 'LOST') = ("lost_reason" IS NOT NULL)
      AND ("lost_reason" IS NULL OR (btrim("lost_reason") <> '' AND length("lost_reason") <= 500))),
    CONSTRAINT "sales_prospects_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "sales_prospects_serial_key" ON "sales_prospects"("serial");
CREATE UNIQUE INDEX "sales_prospects_code_key" ON "sales_prospects"("code");
CREATE INDEX "sales_prospects_owner_id_idx" ON "sales_prospects"("owner_id");
CREATE INDEX "sales_prospects_name_key_idx" ON "sales_prospects"("name_key");
CREATE INDEX "sales_prospects_website_key_idx" ON "sales_prospects"("website_key");
ALTER TABLE "sales_prospects"
  ADD CONSTRAINT "sales_prospects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_prospects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_prospects_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "code_counters" ("name", "last_value") VALUES ('sales_prospect', 0);

-- ---------------------------------------------------------------------------------------------
-- 2. Contacts (a person or a designation such as "Recepce"; retired, never deleted)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "sales_contacts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prospect_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" TEXT,
    "email" TEXT,
    "email_key" TEXT,
    "phone" TEXT,
    "phone_key" TEXT,
    "note" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by" UUID,
    "retire_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "sales_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_contacts_text_check" CHECK (
      btrim("label") <> '' AND length("label") <= 160
      AND ("position" IS NULL OR (btrim("position") <> '' AND length("position") <= 120))
      AND ("email" IS NULL OR (btrim("email") <> '' AND length("email") <= 254))
      AND ("phone" IS NULL OR (btrim("phone") <> '' AND length("phone") <= 40))
      AND ("note" IS NULL OR (btrim("note") <> '' AND length("note") <= 1000))),
    CONSTRAINT "sales_contacts_retired_check" CHECK (
      ("retired_at" IS NULL) = ("retired_by" IS NULL) AND ("retired_at" IS NULL) = ("retire_reason" IS NULL)
      AND ("retired_at" IS NULL OR NOT "is_primary")),
    CONSTRAINT "sales_contacts_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "sales_contacts_id_prospect_id_key" ON "sales_contacts"("id", "prospect_id");
CREATE INDEX "sales_contacts_prospect_id_idx" ON "sales_contacts"("prospect_id");
CREATE INDEX "sales_contacts_email_key_idx" ON "sales_contacts"("email_key");
CREATE INDEX "sales_contacts_phone_key_idx" ON "sales_contacts"("phone_key");
-- At most one active main contact per prospect.
CREATE UNIQUE INDEX "sales_contacts_one_primary" ON "sales_contacts"("prospect_id")
  WHERE "is_primary" AND "retired_at" IS NULL;
ALTER TABLE "sales_contacts"
  ADD CONSTRAINT "sales_contacts_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_contacts_retired_by_fkey" FOREIGN KEY ("retired_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_contacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_contacts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3. Activities (append-only; a correction or withdrawal is a new row pointing to the old one)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "sales_activities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prospect_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    -- When it really happened (entered by the salesperson) and when it was written down.
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "author_id" UUID NOT NULL,
    "contact_id" UUID,
    "content" TEXT,
    "outcome" TEXT,
    "corrects_id" UUID,
    "correction_reason" TEXT,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "request_id" UUID NOT NULL,

    CONSTRAINT "sales_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_activities_kind_check" CHECK (
      "kind" IN ('CALL', 'EMAIL_SENT', 'EMAIL_RECEIVED', 'MEETING', 'SAMPLES', 'OFFER', 'NOTE')),
    -- Something that happened: never in the future of its recording (5 min clock tolerance).
    CONSTRAINT "sales_activities_time_check" CHECK (
      "occurred_at" <= "recorded_at" + interval '5 minutes' AND "occurred_at" >= TIMESTAMPTZ '2000-01-01 00:00:00Z'),
    CONSTRAINT "sales_activities_text_check" CHECK (
      ("content" IS NULL OR (btrim("content") <> '' AND length("content") <= 4000))
      AND ("outcome" IS NULL OR (btrim("outcome") <> '' AND length("outcome") <= 1000))),
    -- A withdrawal has no content; everything else has content.
    CONSTRAINT "sales_activities_withdrawn_check" CHECK (
      ("withdrawn" AND "content" IS NULL AND "outcome" IS NULL AND "corrects_id" IS NOT NULL)
      OR (NOT "withdrawn" AND "content" IS NOT NULL)),
    -- A correction always carries its reason.
    CONSTRAINT "sales_activities_correction_check" CHECK (
      ("corrects_id" IS NULL) = ("correction_reason" IS NULL)
      AND ("correction_reason" IS NULL OR (btrim("correction_reason") <> '' AND length("correction_reason") <= 500)))
);
CREATE UNIQUE INDEX "sales_activities_id_prospect_id_key" ON "sales_activities"("id", "prospect_id");
CREATE UNIQUE INDEX "sales_activities_request_id_key" ON "sales_activities"("request_id");
-- Each activity is corrected at most once (a chain of versions, never a fork).
CREATE UNIQUE INDEX "sales_activities_corrects_id_key" ON "sales_activities"("corrects_id");
CREATE INDEX "sales_activities_prospect_id_occurred_at_idx" ON "sales_activities"("prospect_id", "occurred_at");
ALTER TABLE "sales_activities"
  ADD CONSTRAINT "sales_activities_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_activities_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The contact and the corrected activity belong to the same prospect.
  ADD CONSTRAINT "sales_activities_contact_id_prospect_id_fkey" FOREIGN KEY ("contact_id", "prospect_id") REFERENCES "sales_contacts"("id", "prospect_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_activities_corrects_id_prospect_id_fkey" FOREIGN KEY ("corrects_id", "prospect_id") REFERENCES "sales_activities"("id", "prospect_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "sales_activities_append_only" BEFORE UPDATE OR DELETE ON "sales_activities"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_activities_no_truncate" BEFORE TRUNCATE ON "sales_activities"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 4. Tasks (current state; created, rescheduled, done and cancelled through sales_events)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "sales_tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prospect_id" UUID NOT NULL,
    "contact_id" UUID,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "assignee_id" UUID NOT NULL,
    -- A calendar day in the sales time zone (doc 034 §6).
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "result" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,

    CONSTRAINT "sales_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_tasks_text_check" CHECK (
      btrim("title") <> '' AND length("title") <= 200
      AND ("note" IS NULL OR (btrim("note") <> '' AND length("note") <= 2000))
      AND ("result" IS NULL OR (btrim("result") <> '' AND length("result") <= 1000))),
    CONSTRAINT "sales_tasks_status_check" CHECK ("status" IN ('OPEN', 'DONE', 'CANCELLED')),
    -- A closed task says who closed it and when; a cancellation says why (in "result").
    CONSTRAINT "sales_tasks_closed_check" CHECK (
      ("status" = 'OPEN') = ("closed_at" IS NULL) AND ("closed_at" IS NULL) = ("closed_by" IS NULL)
      AND ("status" <> 'CANCELLED' OR "result" IS NOT NULL)
      AND ("status" <> 'OPEN' OR "result" IS NULL)),
    CONSTRAINT "sales_tasks_due_check" CHECK ("due_on" >= DATE '2000-01-01'),
    CONSTRAINT "sales_tasks_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "sales_tasks_id_prospect_id_key" ON "sales_tasks"("id", "prospect_id");
CREATE INDEX "sales_tasks_prospect_id_idx" ON "sales_tasks"("prospect_id");
CREATE INDEX "sales_tasks_assignee_open_idx" ON "sales_tasks"("assignee_id", "due_on") WHERE "status" = 'OPEN';
CREATE INDEX "sales_tasks_open_due_idx" ON "sales_tasks"("prospect_id", "due_on") WHERE "status" = 'OPEN';
ALTER TABLE "sales_tasks"
  ADD CONSTRAINT "sales_tasks_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_tasks_contact_id_prospect_id_fkey" FOREIGN KEY ("contact_id", "prospect_id") REFERENCES "sales_contacts"("id", "prospect_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_tasks_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_tasks_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A closed task stays closed (a new task is created instead — doc 034 §6).
CREATE FUNCTION sales_tasks_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: sales tasks are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'AYVO: a closed sales task does not change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."prospect_id" <> OLD."prospect_id" OR NEW."created_at" <> OLD."created_at"
     OR NEW."created_by" <> OLD."created_by" OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'AYVO: a sales task changes only to its next revision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_tasks_guard" BEFORE UPDATE OR DELETE ON "sales_tasks"
  FOR EACH ROW EXECUTE FUNCTION sales_tasks_guard();

-- Prospects and contacts: never deleted; each change is the next revision; identity immutable.
CREATE FUNCTION sales_current_state_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" <> OLD."created_by"
     OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'AYVO: % changes only to its next revision', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_prospects_guard" BEFORE UPDATE OR DELETE ON "sales_prospects"
  FOR EACH ROW EXECUTE FUNCTION sales_current_state_guard();
CREATE TRIGGER "sales_contacts_guard" BEFORE UPDATE OR DELETE ON "sales_contacts"
  FOR EACH ROW EXECUTE FUNCTION sales_current_state_guard();
CREATE FUNCTION sales_prospects_identity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."serial" <> OLD."serial" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'AYVO: a prospect code is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_prospects_identity" BEFORE UPDATE ON "sales_prospects"
  FOR EACH ROW EXECUTE FUNCTION sales_prospects_identity();
CREATE FUNCTION sales_contacts_identity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."prospect_id" <> OLD."prospect_id" OR OLD."retired_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a contact keeps its prospect; a retired contact does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_contacts_identity" BEFORE UPDATE ON "sales_contacts"
  FOR EACH ROW EXECUTE FUNCTION sales_contacts_identity();
CREATE TRIGGER "sales_prospects_no_truncate" BEFORE TRUNCATE ON "sales_prospects"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_contacts_no_truncate" BEFORE TRUNCATE ON "sales_contacts"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_tasks_no_truncate" BEFORE TRUNCATE ON "sales_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 5. Events (append-only history of every change of current state)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "sales_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prospect_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "contact_id" UUID,
    "task_id" UUID,
    "payload" JSONB NOT NULL,
    "request_id" UUID NOT NULL,

    CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_events_type_check" CHECK ("type" IN (
      'PROSPECT_CREATED', 'PROSPECT_UPDATED', 'STAGE_CHANGED', 'OWNER_CHANGED',
      'CONTACT_ADDED', 'CONTACT_UPDATED', 'CONTACT_RETIRED',
      'TASK_CREATED', 'TASK_UPDATED', 'TASK_RESCHEDULED', 'TASK_DONE', 'TASK_CANCELLED')),
    CONSTRAINT "sales_events_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
CREATE INDEX "sales_events_prospect_id_occurred_at_idx" ON "sales_events"("prospect_id", "occurred_at");
CREATE INDEX "sales_events_task_id_idx" ON "sales_events"("task_id");
ALTER TABLE "sales_events"
  ADD CONSTRAINT "sales_events_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "sales_prospects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The contact or task of an event belongs to the event's prospect.
  ADD CONSTRAINT "sales_events_contact_id_prospect_id_fkey" FOREIGN KEY ("contact_id", "prospect_id") REFERENCES "sales_contacts"("id", "prospect_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sales_events_task_id_prospect_id_fkey" FOREIGN KEY ("task_id", "prospect_id") REFERENCES "sales_tasks"("id", "prospect_id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "sales_events_append_only" BEFORE UPDATE OR DELETE ON "sales_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_events_no_truncate" BEFORE TRUNCATE ON "sales_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- 6. Permissions (doc 034 §7): company-wide (no site), SALES = Obchod only
-- ---------------------------------------------------------------------------------------------

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('sales:work', 'Obchod: own hotel prospects — create (owned by the creator), read and edit them, their contacts, activities and tasks', false, false, false, NULL),
  ('sales:manage', 'Obchod: every prospect and task; assign and reassign prospects to salespeople', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'sales:work'),
  ('ADMIN', 'sales:manage'),
  ('SALES', 'sales:work');

-- SALES becomes the Obchod role only: no warehouse access (the planning stock summary stays
-- available to custom roles).
DELETE FROM "role_permissions" WHERE "role_code" = 'SALES' AND "permission_code" = 'inventory:stock_summary';
UPDATE "roles"
  SET "description" = 'Obchod: hotel acquisition — own prospects, contacts, activities and tasks (doc 034)'
  WHERE "code" = 'SALES';

SELECT set_config('ayvo.catalogue_migration', 'off', false);
