-- R2 "Po mytí" (doc 048 §1–§2): the second scan, after physical washing and inspection.
-- RETURNED → READY_FOR_REUSE with exactly one REUSE_READY per return, the bottle's open pump
-- attachment closed (CLEANING_REQUIRED) in the same transaction, nothing consumed. The bottle
-- keeps its row, QR, code and product binding. In R2 a READY_FOR_REUSE bottle enters no crate:
-- crate_assignments_member_placeable (20261110090000) already admits only LABELED_EMPTY and FILLED
-- members, and the commit check below keeps it out of every crate. The ledger is unchanged: only
-- LABEL_APPLICATION (→ LABEL_APPLIED) and FILL (→ FILLED) movements may name a bottle event.
-- No existing row is rewritten.

-- =============================================================================================
-- REUSE_READY at insert: a RETURNED bottle (locked), its operation and actor; no crate, station,
-- lot or return line (doc 048 §2.1)
-- =============================================================================================

CREATE FUNCTION bottle_events_reuse_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "BottleStatus";
BEGIN
  IF NEW."type" <> 'REUSE_READY' THEN
    RETURN NEW;
  END IF;
  IF NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL THEN
    RAISE EXCEPTION 'AYVO: REUSE_READY names its operation and actor' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crate_cycle_id" IS NOT NULL OR NEW."workstation_session_id" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: REUSE_READY belongs to no crate cycle or station (R2)' USING ERRCODE = 'check_violation';
  END IF;
  -- The bottle row lock serialises two concurrent "Po mytí" of the same bottle: the second sees
  -- the first's READY_FOR_REUSE after it commits and is refused here.
  SELECT "status" INTO st FROM "bottles" WHERE "id" = NEW."bottle_id" FOR UPDATE;
  IF st IS DISTINCT FROM 'RETURNED' THEN
    RAISE EXCEPTION 'AYVO: only a RETURNED bottle becomes ready for reuse (it is %)', st
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "bottle_events_reuse_rules" BEFORE INSERT ON "bottle_events"
  FOR EACH ROW EXECUTE FUNCTION bottle_events_reuse_rules();

-- At commit: the REUSE_READY made its bottle READY_FOR_REUSE in the same transaction, and every
-- attachment it closed is the pump, set aside for cleaning.
CREATE FUNCTION bottle_events_reuse_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" <> 'REUSE_READY' THEN
    RETURN NULL;
  END IF;
  IF (SELECT "status" FROM "bottles" WHERE "id" = NEW."bottle_id") IS DISTINCT FROM 'READY_FOR_REUSE' THEN
    RAISE EXCEPTION 'AYVO: REUSE_READY makes the bottle READY_FOR_REUSE' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "bottle_component_attachments"
              WHERE "removal_event_id" = NEW."id"
                AND ("component_type" <> 'PUMP' OR "disposition" IS DISTINCT FROM 'CLEANING_REQUIRED')) THEN
    RAISE EXCEPTION 'AYVO: REUSE_READY closes only the pump, for cleaning' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "bottle_events_reuse_complete" AFTER INSERT ON "bottle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottle_events_reuse_complete();

-- =============================================================================================
-- Statuses: the R1 path plus RETURNED → READY_FOR_REUSE (nothing else leaves READY_FOR_REUSE in R2)
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottles_status_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'LABELED_EMPTY')
     AND NOT (OLD."status" = 'LABELED_EMPTY' AND NEW."status" = 'FILLED')
     AND NOT (OLD."status" = 'FILLED' AND NEW."status" IN ('RETURNED', 'RETIRED'))
     AND NOT (OLD."status" = 'RETURNED' AND NEW."status" IN ('RETIRED', 'READY_FOR_REUSE'))
     AND NOT (OLD."status" = 'RETIRED' AND NEW."status" IN ('DISPOSED', 'RETURNED')) THEN
    RAISE EXCEPTION 'AYVO: bottle status % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: every status is backed by its event (R1, unchanged for the other statuses). A
-- READY_FOR_REUSE bottle (positive match): its last return event is a REUSE_READY, exactly one
-- REUSE_READY after its last SORTED, came back by an identification from its latest crate, is in
-- no crate and has no open pump attachment.
CREATE OR REPLACE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  member_cycle uuid;
  last_event record;
  last_sorted uuid;
  backed boolean;
BEGIN
  IF NEW."status" = 'LABELED_EMPTY' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'LABEL_APPLIED') THEN
    RAISE EXCEPTION 'AYVO: a labelled bottle needs its LABEL_APPLIED event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLED' THEN
    IF NOT EXISTS (SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'FILLED') THEN
      RAISE EXCEPTION 'AYVO: a filled bottle needs its FILLED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "cycle_id" INTO member_cycle FROM "crate_assignments"
     WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL;
    IF member_cycle IS NOT NULL THEN
      PERFORM ayvo_assert_crate_cycle(member_cycle);
    END IF;
  END IF;
  IF NEW."status" IN ('RETURNED', 'RETIRED', 'DISPOSED', 'READY_FOR_REUSE') THEN
    SELECT "type", "payload" INTO last_event FROM "bottle_events"
     WHERE "bottle_id" = NEW."id" AND "type" IN ('SORTED', 'RETIRED', 'DISPOSED', 'CORRECTION', 'REUSE_READY')
     ORDER BY "id" DESC LIMIT 1;
    -- A positive match only: no such event at all (a loose filled bottle) is never enough.
    backed := coalesce(
         (NEW."status" = 'RETURNED' AND (last_event."type" = 'CORRECTION'
            OR (last_event."type" = 'SORTED' AND last_event."payload"->>'outcome' = 'RETURNED')))
      OR (NEW."status" = 'RETIRED' AND last_event."type" = 'RETIRED')
      OR (NEW."status" = 'DISPOSED' AND last_event."type" = 'DISPOSED')
      OR (NEW."status" = 'READY_FOR_REUSE' AND last_event."type" = 'REUSE_READY'), false);
    IF NOT backed THEN
      RAISE EXCEPTION 'AYVO: bottle status % needs its event', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'READY_FOR_REUSE' THEN
      SELECT "id" INTO last_sorted FROM "bottle_events"
       WHERE "bottle_id" = NEW."id" AND "type" = 'SORTED' ORDER BY "id" DESC LIMIT 1;
      IF last_sorted IS NULL OR (SELECT count(*) FROM "bottle_events"
            WHERE "bottle_id" = NEW."id" AND "type" = 'REUSE_READY' AND "id" > last_sorted) <> 1 THEN
        RAISE EXCEPTION 'AYVO: a bottle is ready for reuse by exactly one REUSE_READY after its return'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "bottle_component_attachments"
                  WHERE "bottle_id" = NEW."id" AND "component_type" = 'PUMP' AND "removed_at" IS NULL) THEN
        RAISE EXCEPTION 'AYVO: a bottle ready for reuse has no pump attached (closed for cleaning)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- …and the bottle came back by an identification: its latest crate membership was ended by
    -- its SORTED (a bottle taken out of a crate in production was never returned).
    IF NOT EXISTS (
         SELECT 1 FROM "crate_assignments" a JOIN "bottle_events" e ON e."id" = a."released_event_id"
          WHERE a."bottle_id" = NEW."id" AND e."type" = 'SORTED'
            AND a."assigned_at" = (SELECT max(x."assigned_at") FROM "crate_assignments" x WHERE x."bottle_id" = NEW."id")) THEN
      RAISE EXCEPTION 'AYVO: a % bottle was identified at a return from its latest crate', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "crate_assignments" WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL) THEN
      RAISE EXCEPTION 'AYVO: a % bottle is in no crate', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
