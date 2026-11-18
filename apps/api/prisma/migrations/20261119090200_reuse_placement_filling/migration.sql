-- R3-b (doc 048 §3.0, §3.1, §3.3, §8.2 step 2; owner 2026-11-09: a washed bottle is scanned and
-- treated like a new one; new and washed bottles may share a crate). A READY_FOR_REUSE bottle
-- joins an assembling crate as a REUSE member (no label, nothing consumed) and is filled like a
-- new one, except that a washed pump from the anonymous pool is put on it: its FILL consumes the
-- recipe's FILL BOM without its PUMP lines. Every other rule is unchanged. No row is rewritten.

-- =============================================================================================
-- Assignments: REUSE only into OPEN_ASSEMBLY (as a labelling scan)
-- =============================================================================================

CREATE OR REPLACE FUNCTION crate_assignments_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle_status "CrateCycleStatus";
BEGIN
  IF NEW."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: an assignment starts active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."status" INTO cycle_status FROM "crate_cycles" c WHERE c."id" = NEW."cycle_id";
  IF NOT ((NEW."source" IN ('LABELING', 'REUSE') AND cycle_status = 'OPEN_ASSEMBLY')
       OR (NEW."source" = 'REPACKED' AND cycle_status IN ('OPEN_ASSEMBLY', 'FILLING'))
       OR (NEW."source" = 'REPLACEMENT' AND cycle_status = 'FILLING')) THEN
    RAISE EXCEPTION 'AYVO: a % assignment into a % cycle is not allowed', NEW."source", cycle_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c JOIN "bottles" b ON b."id" = NEW."bottle_id"
                  WHERE c."id" = NEW."cycle_id" AND b."site_id" = c."site_id") THEN
    RAISE EXCEPTION 'AYVO: a bottle joins only a crate of its own site' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "bottle_events" e
                  WHERE e."id" = NEW."assigned_event_id" AND e."bottle_id" = NEW."bottle_id"
                    AND e."type" = 'ASSIGNED_TO_CRATE' AND e."crate_cycle_id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: an assignment needs the bottle''s ASSIGNED_TO_CRATE event of this cycle'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: a new member is LABELED_EMPTY or FILLED — or, as a REUSE member and only so, a
-- washed bottle (READY_FOR_REUSE) placed after its latest REUSE_READY.
CREATE OR REPLACE FUNCTION crate_assignments_member_placeable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "BottleStatus";
  last_ready uuid;
BEGIN
  SELECT b."status" INTO st FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."id" = NEW."id" AND a."released_at" IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NEW."source" = 'REUSE' THEN
    SELECT "id" INTO last_ready FROM "bottle_events"
     WHERE "bottle_id" = NEW."bottle_id" AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1;
    IF st IS DISTINCT FROM 'READY_FOR_REUSE' OR last_ready IS NULL OR NEW."assigned_event_id" < last_ready THEN
      RAISE EXCEPTION 'AYVO: a REUSE member is a washed bottle placed after its REUSE_READY'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF st NOT IN ('LABELED_EMPTY', 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a crate takes a new member only in LABELED_EMPTY or FILLED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- A member matches the cycle's product and label design (its binding) and — once it has one — the
-- recipe it was filled by: a REUSE member (empty, washed) has none yet; a later member of a bottle
-- that was placed by REUSE carries the recipe of that REUSE cycle; otherwise of the cycle it was
-- labelled in (unchanged).
CREATE OR REPLACE FUNCTION crate_assignments_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  origin uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c
                  JOIN "bottle_product_bindings" pb ON pb."bottle_id" = NEW."bottle_id"
                  WHERE c."id" = NEW."cycle_id" AND pb."product_id" = c."product_id"
                    AND pb."label_template_version_id" = c."label_template_version_id") THEN
    RAISE EXCEPTION 'AYVO: a crate member must match the cycle''s product, label design and recipe version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source" <> 'REUSE' THEN
    SELECT a."cycle_id" INTO origin FROM "crate_assignments" a
     WHERE a."bottle_id" = NEW."bottle_id" AND a."source" = 'REUSE' AND a."id" <> NEW."id"
     ORDER BY a."assigned_at" DESC, a."id" DESC LIMIT 1;
    IF origin IS NULL THEN
      SELECT pb."crate_cycle_id" INTO origin FROM "bottle_product_bindings" pb
       WHERE pb."bottle_id" = NEW."bottle_id";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c JOIN "crate_cycles" o ON o."id" = origin
                    WHERE c."id" = NEW."cycle_id" AND o."recipe_version_id" = c."recipe_version_id") THEN
      RAISE EXCEPTION 'AYVO: a crate member must match the cycle''s product, label design and recipe version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM ayvo_assert_crate_cycle(NEW."cycle_id");
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Statuses: the R2 path plus READY_FOR_REUSE → FILLED (its refilling)
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottles_status_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'LABELED_EMPTY')
     AND NOT (OLD."status" IN ('LABELED_EMPTY', 'READY_FOR_REUSE') AND NEW."status" = 'FILLED')
     AND NOT (OLD."status" = 'FILLED' AND NEW."status" IN ('RETURNED', 'RETIRED'))
     AND NOT (OLD."status" = 'RETURNED' AND NEW."status" IN ('RETIRED', 'READY_FOR_REUSE'))
     AND NOT (OLD."status" = 'RETIRED' AND NEW."status" IN ('DISPOSED', 'RETURNED')) THEN
    RAISE EXCEPTION 'AYVO: bottle status % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: as R2, except that a washed bottle may be in exactly its REUSE membership.
CREATE OR REPLACE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  member_cycle uuid;
  last_event record;
  last_sorted uuid;
  backed boolean;
  last_ready uuid;
BEGIN
  IF NEW."status" = 'LABELED_EMPTY' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'LABEL_APPLIED') THEN
    RAISE EXCEPTION 'AYVO: a labelled bottle needs its LABEL_APPLIED event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLED' THEN
    -- The FILLED of its CURRENT circulation (its latest LABEL_APPLIED / REUSE_READY), not of an
    -- earlier one: a washed bottle is never "filled" by its previous filling (R3-b).
    IF NOT EXISTS (SELECT 1 FROM "bottle_fill_circulations" fc
                    WHERE fc."circulation_event_id" = (
                      SELECT "id" FROM "bottle_events" WHERE "bottle_id" = NEW."id"
                         AND "type" IN ('LABEL_APPLIED', 'REUSE_READY') ORDER BY "id" DESC LIMIT 1)) THEN
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
    -- …and the bottle came back by an identification: its latest crate membership BEFORE its
    -- latest REUSE_READY (for a washed bottle; else its latest at all) was ended by its SORTED (a
    -- bottle taken out of a crate in production was never returned).
    SELECT "id" INTO last_ready FROM "bottle_events"
     WHERE "bottle_id" = NEW."id" AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1;
    IF NEW."status" <> 'READY_FOR_REUSE' THEN
      last_ready := NULL;
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM "crate_assignments" a JOIN "bottle_events" e ON e."id" = a."released_event_id"
          WHERE a."bottle_id" = NEW."id" AND e."type" = 'SORTED'
            AND a."assigned_at" = (SELECT max(x."assigned_at") FROM "crate_assignments" x
                                    WHERE x."bottle_id" = NEW."id"
                                      AND (last_ready IS NULL OR x."assigned_event_id" < last_ready))) THEN
      RAISE EXCEPTION 'AYVO: a % bottle was identified at a return from its latest crate', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- In no crate — except a washed bottle, in exactly its REUSE membership placed after its
    -- latest REUSE_READY (R3-b, doc 048 §3.0).
    IF EXISTS (SELECT 1 FROM "crate_assignments" WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL
                AND NOT (last_ready IS NOT NULL AND "source" = 'REUSE' AND "assigned_event_id" > last_ready)) THEN
      RAISE EXCEPTION 'AYVO: a % bottle is in no crate', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Filling: one complete FILL BOM — without its PUMP lines for a washed bottle's circulation (a
-- washed pump from the anonymous pool, no stock record; doc 048 §3.1–§3.2). The pump attachment
-- is installed either way.
-- =============================================================================================

CREATE OR REPLACE FUNCTION ayvo_assert_fill_complete(p_event_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  event record;
  versions int;
  consumed int;
  required int;
  pumps int;
  bom uuid;
  reused boolean;
BEGIN
  SELECT * INTO event FROM "bottle_events" WHERE "id" = p_event_id;
  IF event."type" <> 'FILLED' THEN
    RAISE EXCEPTION 'AYVO: filling stock must be consumed by a FILLED event' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "bottles" WHERE "id" = event."bottle_id") <> 'FILLED' THEN
    RAISE EXCEPTION 'AYVO: FILLED requires the bottle status change' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "bottle_component_attachments"
                 WHERE "installed_event_id" = p_event_id AND "bottle_id" = event."bottle_id"
                   AND "component_type" = 'PUMP') THEN
    RAISE EXCEPTION 'AYVO: FILLED requires its pump attachment' USING ERRCODE = 'check_violation';
  END IF;
  reused := EXISTS (SELECT 1 FROM "bottle_fill_circulations" fc
                      JOIN "bottle_events" c ON c."id" = fc."circulation_event_id"
                     WHERE fc."filled_event_id" = p_event_id AND c."type" = 'REUSE_READY');
  SELECT count(DISTINCT b."bom_version_id"), count(*), min(b."bom_version_id"::text)::uuid,
         count(*) FILTER (WHERE i."kind" = 'PUMP')
    INTO versions, consumed, bom, pumps
    FROM "inventory_movements" m JOIN "bom_lines" b ON b."id" = m."bom_line_id"
    JOIN "inventory_items" i ON i."id" = b."item_id"
    WHERE m."bottle_event_id" = p_event_id AND m."type" = 'FILL';
  SELECT count(*) INTO required FROM "bom_lines" b JOIN "inventory_items" i ON i."id" = b."item_id"
   WHERE b."bom_version_id" = bom AND (NOT reused OR i."kind" <> 'PUMP');
  IF reused AND pumps <> 0 THEN
    RAISE EXCEPTION 'AYVO: a washed bottle''s filling consumes no new pump' USING ERRCODE = 'check_violation';
  END IF;
  IF versions <> 1 OR consumed <> required THEN
    RAISE EXCEPTION 'AYVO: FILLED must consume exactly one complete filling BOM' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "recipe_revision_boms" x JOIN "crate_cycles" c ON c."recipe_version_id" = x."recipe_version_id"
                  WHERE c."id" = event."crate_cycle_id" AND x."stage" = 'FILL' AND x."bom_version_id" = bom) THEN
    RAISE EXCEPTION 'AYVO: a bottle is filled by the FILL BOM of its crate cycle''s recipe' USING ERRCODE = 'check_violation';
  END IF;
END
$$;
