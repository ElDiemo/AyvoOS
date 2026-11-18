-- R3-a (doc 048 §3.3b–§3.3c, §8.2 step 1; owner 2026-11-09 approved R3): ONE filling per
-- circulation of a bottle, also in the database. A circulation is the event that made the bottle
-- fillable: its LABEL_APPLIED (first circulation) or a REUSE_READY (each later one, after a real
-- return). Each FILLED is anchored to it in an insert-only side table written by the database
-- itself (the R2 code, which knows no anchor, keeps working). No placement change: a
-- READY_FOR_REUSE bottle still enters no crate (R3-b). No bottle_events row is rewritten.

-- No FILLED may be written while the anchors are backfilled and the rule is switched.
LOCK TABLE "bottle_events" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "bottle_fill_circulations" (
  "filled_event_id" uuid NOT NULL,
  "circulation_event_id" uuid NOT NULL,
  CONSTRAINT "bottle_fill_circulations_pkey" PRIMARY KEY ("filled_event_id"),
  CONSTRAINT "bottle_fill_circulations_circulation_key" UNIQUE ("circulation_event_id"),
  CONSTRAINT "bottle_fill_circulations_filled_fkey" FOREIGN KEY ("filled_event_id")
    REFERENCES "bottle_events" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bottle_fill_circulations_circulation_fkey" FOREIGN KEY ("circulation_event_id")
    REFERENCES "bottle_events" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- =============================================================================================
-- The side table: insert-only, and a row is only ever a FILLED and the circulation it belongs to
-- (the same bottle; the latest LABEL_APPLIED / REUSE_READY before that FILLED).
-- =============================================================================================

CREATE FUNCTION bottle_fill_circulations_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  filled record;
  anchor record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AYVO: bottle_fill_circulations is insert-only' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "id", "bottle_id", "type" INTO filled FROM "bottle_events" WHERE "id" = NEW."filled_event_id";
  SELECT "id", "bottle_id", "type" INTO anchor FROM "bottle_events" WHERE "id" = NEW."circulation_event_id";
  IF filled."type" IS DISTINCT FROM 'FILLED' THEN
    RAISE EXCEPTION 'AYVO: a fill circulation row names a FILLED event' USING ERRCODE = 'check_violation';
  END IF;
  IF anchor."type" IS DISTINCT FROM 'LABEL_APPLIED' AND anchor."type" IS DISTINCT FROM 'REUSE_READY' THEN
    RAISE EXCEPTION 'AYVO: a circulation is a LABEL_APPLIED or a REUSE_READY' USING ERRCODE = 'check_violation';
  END IF;
  IF anchor."bottle_id" IS DISTINCT FROM filled."bottle_id" OR anchor."id" >= filled."id" THEN
    RAISE EXCEPTION 'AYVO: the circulation is an earlier event of the same bottle' USING ERRCODE = 'check_violation';
  END IF;
  -- The latest circulation before this FILLED: no older one can be filled again.
  IF EXISTS (SELECT 1 FROM "bottle_events"
              WHERE "bottle_id" = filled."bottle_id" AND "type" IN ('LABEL_APPLIED', 'REUSE_READY')
                AND "id" > anchor."id" AND "id" < filled."id") THEN
    RAISE EXCEPTION 'AYVO: a FILLED belongs to the bottle''s latest circulation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "bottle_fill_circulations_rules" BEFORE INSERT OR UPDATE OR DELETE ON "bottle_fill_circulations"
  FOR EACH ROW EXECUTE FUNCTION bottle_fill_circulations_rules();

-- =============================================================================================
-- Backfill by INSERT: today at most one FILLED per bottle (bottle_events_one_filled_per_bottle),
-- each in the circulation of its bottle's LABEL_APPLIED. No event row or payload is touched.
-- =============================================================================================

INSERT INTO "bottle_fill_circulations" ("filled_event_id", "circulation_event_id")
SELECT f."id",
       (SELECT l."id" FROM "bottle_events" l
         WHERE l."bottle_id" = f."bottle_id" AND l."type" = 'LABEL_APPLIED' AND l."id" < f."id"
         ORDER BY l."id" DESC LIMIT 1)
  FROM "bottle_events" f
 WHERE f."type" = 'FILLED';

-- =============================================================================================
-- Every new FILLED gets its anchor from the locked bottle: LABELED_EMPTY → its latest
-- LABEL_APPLIED, READY_FOR_REUSE → its latest REUSE_READY. The bottle row lock serialises two
-- fillings of one bottle; the unique circulation refuses a second one in the same circulation
-- (another crate after REPACKED, direct SQL, two concurrent requests).
-- =============================================================================================

CREATE FUNCTION bottle_events_fill_circulation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "BottleStatus";
  circulation uuid;
BEGIN
  IF NEW."type" <> 'FILLED' THEN
    RETURN NULL;
  END IF;
  SELECT "status" INTO st FROM "bottles" WHERE "id" = NEW."bottle_id" FOR UPDATE;
  IF st = 'LABELED_EMPTY' THEN
    SELECT "id" INTO circulation FROM "bottle_events"
     WHERE "bottle_id" = NEW."bottle_id" AND "type" = 'LABEL_APPLIED' AND "id" < NEW."id"
     ORDER BY "id" DESC LIMIT 1;
  ELSIF st = 'READY_FOR_REUSE' THEN
    SELECT "id" INTO circulation FROM "bottle_events"
     WHERE "bottle_id" = NEW."bottle_id" AND "type" = 'REUSE_READY' AND "id" < NEW."id"
     ORDER BY "id" DESC LIMIT 1;
  ELSE
    RAISE EXCEPTION 'AYVO: only an empty labelled or a washed bottle is filled (it is %)', st
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF circulation IS NULL THEN
    RAISE EXCEPTION 'AYVO: a FILLED needs the event that made its bottle fillable' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO "bottle_fill_circulations" ("filled_event_id", "circulation_event_id")
  VALUES (NEW."id", circulation);
  RETURN NULL;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'AYVO: this circulation of the bottle is already filled' USING ERRCODE = 'unique_violation';
END
$$;

CREATE TRIGGER "bottle_events_fill_circulation" AFTER INSERT ON "bottle_events"
  FOR EACH ROW EXECUTE FUNCTION bottle_events_fill_circulation();

-- Only now: the unique anchor is the stronger rule and already holds for every FILLED.
DROP INDEX "bottle_events_one_filled_per_bottle";
