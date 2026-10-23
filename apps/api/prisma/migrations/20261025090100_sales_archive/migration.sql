-- Obchod — archiving and restoring a prospect (doc 034 §3a). Additive: three nullable columns, two
-- event types and the guards. Archiving is not a stage and deletes nothing; an archived prospect
-- takes no new work until it is restored.

ALTER TABLE "sales_prospects"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "archived_by" UUID,
  ADD COLUMN "archive_reason" TEXT,
  ADD CONSTRAINT "sales_prospects_archived_check" CHECK (
    ("archived_at" IS NULL) = ("archived_by" IS NULL) AND ("archived_at" IS NULL) = ("archive_reason" IS NULL)
    AND ("archive_reason" IS NULL OR (length(btrim("archive_reason")) >= 3 AND length("archive_reason") <= 500))),
  ADD CONSTRAINT "sales_prospects_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_events" DROP CONSTRAINT "sales_events_type_check";
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_type_check" CHECK ("type" IN (
  'PROSPECT_CREATED', 'PROSPECT_UPDATED', 'STAGE_CHANGED', 'OWNER_CHANGED',
  'PROSPECT_ARCHIVED', 'PROSPECT_RESTORED',
  'CONTACT_ADDED', 'CONTACT_UPDATED', 'CONTACT_RETIRED',
  'TASK_CREATED', 'TASK_UPDATED', 'TASK_RESCHEDULED', 'TASK_DONE', 'TASK_CANCELLED'));

-- An archived prospect does not change until it is restored, and it is archived only without open
-- tasks (they are completed or cancelled by a person first, never automatically).
CREATE FUNCTION sales_prospects_archive_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: an archived prospect does not change; restore it first'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."archived_at" IS NULL AND NEW."archived_at" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "sales_tasks" t WHERE t."prospect_id" = NEW."id" AND t."status" = 'OPEN') THEN
    RAISE EXCEPTION 'AYVO: a prospect with open tasks is not archived'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_prospects_archive_guard" BEFORE UPDATE ON "sales_prospects"
  FOR EACH ROW EXECUTE FUNCTION sales_prospects_archive_guard();

-- No new contacts, activities or tasks (and no changes of them) on an archived prospect. The
-- prospect row is locked by the application before such a write, so this holds under concurrency.
CREATE FUNCTION sales_work_requires_active_prospect() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sales_prospects" p WHERE p."id" = NEW."prospect_id" AND p."archived_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: % of an archived prospect do not change; restore it first', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_contacts_active_prospect" BEFORE INSERT OR UPDATE ON "sales_contacts"
  FOR EACH ROW EXECUTE FUNCTION sales_work_requires_active_prospect();
CREATE TRIGGER "sales_activities_active_prospect" BEFORE INSERT ON "sales_activities"
  FOR EACH ROW EXECUTE FUNCTION sales_work_requires_active_prospect();
CREATE TRIGGER "sales_tasks_active_prospect" BEFORE INSERT OR UPDATE ON "sales_tasks"
  FOR EACH ROW EXECUTE FUNCTION sales_work_requires_active_prospect();
