-- Filling, Hotovo and supervised crate corrections (doc 025 A4; owner decisions B2–B5,
-- 2026-10-14; schema approved for A4 on 2026-10-16). Additive: new nullable/defaulted columns
-- (existing rows unchanged, no backfill), the filling consumption rules, the FILLED bottle state,
-- crate cycle counters and transitions, and the supervisor permission. Nothing is created.

-- AlterTable
ALTER TABLE "bottle_events" ADD COLUMN     "liquid_lot_id" UUID;

-- AlterTable
ALTER TABLE "crate_cycles" ADD COLUMN     "filled_at" TIMESTAMPTZ(3),
ADD COLUMN     "filled_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "workstation_sessions" ADD COLUMN     "liquid_lot_id" UUID;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_liquid_lot_id_fkey" FOREIGN KEY ("liquid_lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_liquid_lot_id_fkey" FOREIGN KEY ("liquid_lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Bottles: LABELED_EMPTY → FILLED (never back); one FILLED event per bottle in stage A
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottles_status_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'LABELED_EMPTY')
     AND NOT (OLD."status" = 'LABELED_EMPTY' AND NEW."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: bottle status % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: LABELED_EMPTY ⇔ a LABEL_APPLIED event; FILLED ⇔ a FILLED event, and the crate the
-- bottle sits in counts it.
CREATE OR REPLACE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  member_cycle uuid;
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
  RETURN NULL;
END
$$;

CREATE UNIQUE INDEX "bottle_events_one_filled_per_bottle"
  ON "bottle_events" ("bottle_id") WHERE "type" = 'FILLED';

-- =============================================================================================
-- Bottle events: FILLED only for an active member of a crate in filling, at a station, with its
-- liquid lot; REMOVED_FROM_CRATE names its cycle.
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottle_events_cycle_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'LABEL_APPLIED' AND (NEW."crate_cycle_id" IS NULL OR NEW."workstation_session_id" IS NULL
                                       OR NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a label is applied only into a crate cycle at a workstation (doc 025 A3)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" IN ('ASSIGNED_TO_CRATE', 'REMOVED_FROM_CRATE')
     AND (NEW."crate_cycle_id" IS NULL OR NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: % names its crate cycle, operation and actor', NEW."type" USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."type" = 'FILLED') <> (NEW."liquid_lot_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: exactly a FILLED event names the liquid lot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'FILLED' THEN
    IF NEW."crate_cycle_id" IS NULL OR NEW."workstation_session_id" IS NULL
       OR NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL THEN
      RAISE EXCEPTION 'AYVO: a bottle is filled only in a crate cycle at a workstation (doc 025 A4)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The filling scan never assigns: the bottle is already a member of that crate in filling.
    IF NOT EXISTS (SELECT 1 FROM "crate_assignments" a JOIN "crate_cycles" c ON c."id" = a."cycle_id"
                    WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id"
                      AND a."released_at" IS NULL AND c."status" IN ('READY_TO_FILL', 'FILLING')) THEN
      RAISE EXCEPTION 'AYVO: only an active member of a crate in filling is filled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Stock: FILL movements consume exactly the cycle recipe's FILL BOM, the liquid from the
-- bottle's one lot (owner B5), once per bottle.
-- =============================================================================================

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_source_check";
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_source_check" CHECK (
    ("type" = 'RECEIPT' AND "quantity_delta" > 0 AND "receipt_line_id" IS NOT NULL
       AND "receipt_correction_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL)
    OR ("type" = 'RECEIPT_CORRECTION' AND "receipt_correction_id" IS NOT NULL
       AND "receipt_line_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL)
    OR ("type" IN ('LABEL_APPLICATION', 'FILL') AND "quantity_delta" < 0 AND "bottle_event_id" IS NOT NULL
       AND "bom_line_id" IS NOT NULL AND "receipt_line_id" IS NULL AND "receipt_correction_id" IS NULL));

CREATE OR REPLACE FUNCTION inventory_movements_post() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  tracking "LotTracking";
  src record;
  ev record;
BEGIN
  PERFORM ayvo_assert_unit_scale(NEW."unit_id", NEW."quantity_delta", 'movement quantity');

  SELECT "lot_tracking" INTO tracking FROM "inventory_items" WHERE "id" = NEW."item_id";
  IF (tracking = 'REQUIRED') <> (NEW."lot_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a lot is required exactly for lot-tracked items' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lot_id" IS NOT NULL
     AND (SELECT "item_id" FROM "inventory_lots" WHERE "id" = NEW."lot_id") <> NEW."item_id" THEN
    RAISE EXCEPTION 'AYVO: the lot belongs to another item' USING ERRCODE = 'check_violation';
  END IF;

  -- The movement must be exactly what its source says.
  IF NEW."type" = 'RECEIPT' THEN
    SELECT * INTO src FROM "goods_receipt_lines" WHERE "id" = NEW."receipt_line_id";
    IF src."item_id" <> NEW."item_id" OR src."lot_id" IS DISTINCT FROM NEW."lot_id"
       OR src."quantity" <> NEW."quantity_delta" THEN
      RAISE EXCEPTION 'AYVO: a receipt movement must match its receipt line' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'RECEIPT_CORRECTION' THEN
    SELECT c."quantity_delta", l."item_id", l."lot_id" INTO src
      FROM "goods_receipt_corrections" c JOIN "goods_receipt_lines" l ON l."id" = c."receipt_line_id"
      WHERE c."id" = NEW."receipt_correction_id";
    IF src."item_id" <> NEW."item_id" OR src."lot_id" IS DISTINCT FROM NEW."lot_id"
       OR src."quantity_delta" <> NEW."quantity_delta" THEN
      RAISE EXCEPTION 'AYVO: a correction movement must match its correction' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'LABEL_APPLICATION' THEN
    IF (SELECT "type" FROM "bottle_events" WHERE "id" = NEW."bottle_event_id") <> 'LABEL_APPLIED' THEN
      RAISE EXCEPTION 'AYVO: label application stock must be consumed by a LABEL_APPLIED event'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."item_id", b."quantity", v."stage" INTO src
      FROM "bom_lines" b JOIN "bom_versions" v ON v."id" = b."bom_version_id"
      WHERE b."id" = NEW."bom_line_id";
    IF src."stage" <> 'LABEL_APPLICATION' OR src."item_id" <> NEW."item_id"
       OR NEW."quantity_delta" <> -src."quantity" THEN
      RAISE EXCEPTION 'AYVO: a label application movement must match its BOM line' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'FILL' THEN
    SELECT * INTO ev FROM "bottle_events" WHERE "id" = NEW."bottle_event_id";
    IF ev."type" <> 'FILLED' THEN
      RAISE EXCEPTION 'AYVO: filling stock must be consumed by a FILLED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."item_id", b."quantity", v."stage", i."kind" INTO src
      FROM "bom_lines" b JOIN "bom_versions" v ON v."id" = b."bom_version_id"
      JOIN "inventory_items" i ON i."id" = b."item_id"
      WHERE b."id" = NEW."bom_line_id";
    IF src."stage" <> 'FILL' OR src."item_id" <> NEW."item_id" OR NEW."quantity_delta" <> -src."quantity" THEN
      RAISE EXCEPTION 'AYVO: a filling movement must match its BOM line' USING ERRCODE = 'check_violation';
    END IF;
    IF src."kind" = 'BULK_LIQUID' AND NEW."lot_id" IS DISTINCT FROM ev."liquid_lot_id" THEN
      RAISE EXCEPTION 'AYVO: the liquid is consumed from the bottle''s one liquid lot' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Ensure the balance row exists (at 0), then apply the delta with a plain UPDATE: it takes
  -- the row lock and its CHECK (on_hand >= 0) rejects any overdraw. (An upsert cannot be used:
  -- PostgreSQL checks the proposed insert row — the bare negative delta — before ON CONFLICT.)
  IF NEW."lot_id" IS NULL THEN
    INSERT INTO "inventory_balances" ("item_id", "location_id", "lot_id", "on_hand")
      VALUES (NEW."item_id", NEW."location_id", NULL, 0)
      ON CONFLICT ("item_id", "location_id") WHERE "lot_id" IS NULL DO NOTHING;
    UPDATE "inventory_balances" SET "on_hand" = "on_hand" + NEW."quantity_delta", "updated_at" = now()
      WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id" AND "lot_id" IS NULL
      RETURNING "on_hand" INTO NEW."balance_after";
  ELSE
    INSERT INTO "inventory_balances" ("item_id", "location_id", "lot_id", "on_hand")
      VALUES (NEW."item_id", NEW."location_id", NEW."lot_id", 0)
      ON CONFLICT ("item_id", "location_id", "lot_id") WHERE "lot_id" IS NOT NULL DO NOTHING;
    UPDATE "inventory_balances" SET "on_hand" = "on_hand" + NEW."quantity_delta", "updated_at" = now()
      WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id" AND "lot_id" = NEW."lot_id"
      RETURNING "on_hand" INTO NEW."balance_after";
  END IF;
  RETURN NEW;
END
$$;

-- At commit: a FILLED event comes with the status change, its open PUMP attachment and exactly
-- the consumption of the cycle recipe's complete FILL BOM. Checked when the event is inserted AND
-- whenever a filling movement is inserted later.
CREATE FUNCTION ayvo_assert_fill_complete(p_event_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  event record;
  versions int;
  consumed int;
  required int;
  bom uuid;
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
  SELECT count(DISTINCT b."bom_version_id"), count(*), min(b."bom_version_id"::text)::uuid
    INTO versions, consumed, bom
    FROM "inventory_movements" m JOIN "bom_lines" b ON b."id" = m."bom_line_id"
    WHERE m."bottle_event_id" = p_event_id AND m."type" = 'FILL';
  SELECT count(*) INTO required FROM "bom_lines" WHERE "bom_version_id" = bom;
  IF versions <> 1 OR consumed <> required THEN
    RAISE EXCEPTION 'AYVO: FILLED must consume exactly one complete filling BOM' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "recipe_revision_boms" x JOIN "crate_cycles" c ON c."recipe_version_id" = x."recipe_version_id"
                  WHERE c."id" = event."crate_cycle_id" AND x."stage" = 'FILL' AND x."bom_version_id" = bom) THEN
    RAISE EXCEPTION 'AYVO: a bottle is filled by the FILL BOM of its crate cycle''s recipe' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION bottle_events_fill_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'FILLED' THEN
    PERFORM ayvo_assert_fill_complete(NEW."id");
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "bottle_events_fill_complete" AFTER INSERT ON "bottle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottle_events_fill_complete();

CREATE FUNCTION inventory_movements_fill_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'FILL' THEN
    PERFORM ayvo_assert_fill_complete(NEW."bottle_event_id");
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "inventory_movements_fill_complete" AFTER INSERT ON "inventory_movements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_movements_fill_complete();

-- =============================================================================================
-- Component attachments: a pump is installed by the bottle's FILLED event
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottle_component_attachments_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item record;
  event record;
BEGIN
  SELECT * INTO event FROM "bottle_events" WHERE "id" = NEW."installed_event_id";
  IF event."bottle_id" <> NEW."bottle_id" THEN
    RAISE EXCEPTION 'AYVO: a component is installed by an event of the same bottle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a component attachment starts open' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."component_type" = 'LABEL' THEN
    IF event."type" <> 'LABEL_APPLIED' THEN
      RAISE EXCEPTION 'AYVO: a label is installed by a LABEL_APPLIED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."bottle_id", i."qr_url", j."status" INTO item
      FROM "label_print_job_items" i JOIN "label_print_jobs" j ON j."id" = i."print_job_id"
      WHERE i."print_job_id" = NEW."print_job_id" AND i."position" = NEW."print_job_position";
    IF item."bottle_id" <> NEW."bottle_id" OR item."qr_url" <> NEW."label_qr_url" THEN
      RAISE EXCEPTION 'AYVO: the label must be printed for this bottle with exactly this QR URL'
        USING ERRCODE = 'check_violation';
    END IF;
    IF item."status" <> 'COMPLETED' THEN
      RAISE EXCEPTION 'AYVO: only a label of a COMPLETED print job can be applied'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."component_type" = 'PUMP' THEN
    IF event."type" <> 'FILLED' THEN
      RAISE EXCEPTION 'AYVO: a pump is installed by a FILLED event' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."label_qr_url" IS NOT NULL OR NEW."print_job_id" IS NOT NULL OR NEW."print_job_position" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a pump attachment carries no label' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Crate cycles: filled counter, Hotovo (FILLED), sticky FILLING, a FILLING cycle opened by a
-- repack of finished bottles (doc 025 §3.2, §4.2)
-- =============================================================================================

ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_filled_count_check" CHECK ("filled_count" BETWEEN 0 AND "member_count"),
  ADD CONSTRAINT "crate_cycles_filled_at_check" CHECK (("status" = 'FILLED') = ("filled_at" IS NOT NULL));

CREATE OR REPLACE FUNCTION crate_cycles_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Labelling opens a cycle in OPEN_ASSEMBLY; "Přeložit hotové lahve" into an empty crate opens
  -- it in FILLING with the bottles' snapshot. Always empty at the insert.
  IF NEW."status" NOT IN ('OPEN_ASSEMBLY', 'FILLING') OR NEW."member_count" <> 0 OR NEW."filled_count" <> 0 THEN
    RAISE EXCEPTION 'AYVO: a crate cycle opens empty, in OPEN_ASSEMBLY or (repack) FILLING' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "crates" c JOIN "crate_types" ct ON ct."id" = c."crate_type_id"
                  WHERE c."id" = NEW."crate_id" AND c."status" = 'ACTIVE' AND c."site_id" = NEW."site_id"
                    AND c."crate_type_id" = NEW."crate_type_id" AND ct."capacity" = NEW."capacity") THEN
    RAISE EXCEPTION 'AYVO: cycle snapshot does not match the crate and its type' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "crate_type_categories" x
                  WHERE x."crate_type_id" = NEW."crate_type_id" AND x."category_code" = NEW."category_code") THEN
    RAISE EXCEPTION 'AYVO: the crate type does not carry this product category' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "products" p JOIN "recipe_versions" r ON r."product_id" = p."id"
                  WHERE p."id" = NEW."product_id" AND p."category_code" = NEW."category_code"
                    AND r."id" = NEW."recipe_version_id") THEN
    RAISE EXCEPTION 'AYVO: cycle snapshot: recipe of another product or category' USING ERRCODE = 'check_violation';
  END IF;
  -- A NEW labelling cycle starts only with the product's current ACTIVE recipe of an active
  -- product (owner B2). A repack keeps the finished bottles' own recipe version.
  IF NEW."status" = 'OPEN_ASSEMBLY' AND NOT EXISTS (
       SELECT 1 FROM "products" p JOIN "recipe_versions" r ON r."product_id" = p."id"
        WHERE p."id" = NEW."product_id" AND p."status" = 'ACTIVE'
          AND r."id" = NEW."recipe_version_id" AND r."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'AYVO: a new crate cycle needs the product''s active recipe of an active product'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The crate type is exactly the one of that recipe (its latest, sealed revision).
  IF NEW."crate_type_id" IS DISTINCT FROM (
       SELECT rr."crate_type_id" FROM "recipe_revisions" rr
        WHERE rr."recipe_version_id" = NEW."recipe_version_id"
        ORDER BY rr."revision" DESC LIMIT 1) THEN
    RAISE EXCEPTION 'AYVO: the crate type differs from the crate type of the recipe' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION crate_cycles_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','member_count','filled_count','ready_to_fill_at','filled_at',
                          'aborted_at','aborted_by','abort_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: crate cycles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ABORTED' THEN
    RAISE EXCEPTION 'AYVO: an aborted crate cycle never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" = 'FILLING')) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- FILLING is entered only together with a filled member (a fill scan or a repacked finished
  -- bottle), never by counts or by hand.
  IF NEW."status" = 'FILLING' AND OLD."status" IN ('OPEN_ASSEMBLY', 'READY_TO_FILL') AND NEW."filled_count" < 1 THEN
    RAISE EXCEPTION 'AYVO: a crate enters FILLING only with a filled member' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Counters = active assignments / filled members; each status matches them; FILLED only with all
-- members filled and its Hotovo event — at commit, against the whole transaction.
CREATE OR REPLACE FUNCTION ayvo_assert_crate_cycle(p_cycle_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle record;
  active int;
  filled int;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*), count(*) FILTER (WHERE b."status" = 'FILLED') INTO active, filled
    FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."cycle_id" = p_cycle_id AND a."released_at" IS NULL;
  IF cycle."member_count" <> active OR cycle."filled_count" <> filled THEN
    RAISE EXCEPTION 'AYVO: cycle counters %/% differ from % active and % filled members',
      cycle."member_count", cycle."filled_count", active, filled USING ERRCODE = 'check_violation';
  END IF;
  IF (cycle."status" = 'OPEN_ASSEMBLY' AND (active >= cycle."capacity" OR filled <> 0))
     OR (cycle."status" = 'READY_TO_FILL' AND (active <> cycle."capacity" OR filled <> 0))
     OR (cycle."status" = 'FILLED' AND (active <> cycle."capacity" OR filled <> cycle."capacity"))
     OR (cycle."status" = 'ABORTED' AND active <> 0) THEN
    RAISE EXCEPTION 'AYVO: cycle status % does not match % members / % filled of %',
      cycle."status", active, filled, cycle."capacity" USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'READY_TO_FILL' AND (cycle."ready_to_fill_at" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'READY_TO_FILL')) THEN
    RAISE EXCEPTION 'AYVO: READY_TO_FILL without its event' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'FILLED' AND NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'CRATE_FILLED'
          AND e."occurred_at" = cycle."filled_at") THEN
    RAISE EXCEPTION 'AYVO: FILLED only by Hotovo (its CRATE_FILLED event)' USING ERRCODE = 'check_violation';
  END IF;
  -- Sticky FILLING: it had a filled member (it may have none now, doc 025 §3.2).
  IF cycle."status" = 'FILLING' AND NOT EXISTS (
       SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
        WHERE a."cycle_id" = p_cycle_id AND b."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a FILLING cycle has had a filled member' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- =============================================================================================
-- Crate assignments: labelling assigns into OPEN_ASSEMBLY; supervised repack/replacement into
-- an open cycle; every member matches the cycle snapshot incl. its recipe version
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
  IF NOT ((NEW."source" = 'LABELING' AND cycle_status = 'OPEN_ASSEMBLY')
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

CREATE OR REPLACE FUNCTION crate_assignments_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c
                  JOIN "bottle_product_bindings" pb ON pb."bottle_id" = NEW."bottle_id"
                  JOIN "crate_cycles" origin ON origin."id" = pb."crate_cycle_id"
                  WHERE c."id" = NEW."cycle_id" AND pb."product_id" = c."product_id"
                    AND pb."label_template_version_id" = c."label_template_version_id"
                    AND origin."recipe_version_id" = c."recipe_version_id") THEN
    RAISE EXCEPTION 'AYVO: a crate member must match the cycle''s product, label design and recipe version'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_crate_cycle(NEW."cycle_id");
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Work sessions: the liquid lot exists only at a filling station
-- =============================================================================================

CREATE OR REPLACE FUNCTION workstation_sessions_context_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW."product_id" IS NOT NULL OR NEW."recipe_version_id" IS NOT NULL
      OR NEW."label_template_version_id" IS NOT NULL OR NEW."source_lot_id" IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "workstations" w
                      WHERE w."id" = NEW."workstation_id" AND w."mode" = 'LABELING') THEN
    RAISE EXCEPTION 'AYVO: a labelling context belongs to a labelling station' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."liquid_lot_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "workstations" w WHERE w."id" = NEW."workstation_id" AND w."mode" = 'FILLING') THEN
    RAISE EXCEPTION 'AYVO: a liquid lot is chosen only at a filling station' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crate_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crates" c WHERE c."id" = NEW."crate_id" AND c."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: a station loads only a crate of its site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Permissions (owner B4, doc 025 §7): supervised crate corrections — production supervisor and
-- ADMIN (ADMIN explicitly, doc 021).
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('production:cycle_correct', 'Correct crate cycles of the site: remove, add or repack bottles, return a ready crate to filling, abort a cycle (reason required)', false, false, true, 'PRODUCTION');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'production:cycle_correct'),
  ('PRODUCTION_SUPERVISOR', 'production:cycle_correct');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
