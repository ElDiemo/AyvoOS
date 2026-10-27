-- Consumables and their manual issue to consumption (owner 2026-10-27, doc 018 §5a): e.g. a printer
-- ribbon roll (1 pcs = one roll of 300 m) is received like any item and issued to consumption by
-- hand when it is put into a printer — never by a recipe, never estimated per label.
--   * stock_issues: append-only, CONSUMABLE items only, a reason, the actor, one per request id;
--   * exactly one CONSUMPTION_ISSUE movement per issue (deferred check), equal to the issue — so
--     the ledger's balance check refuses a negative stock;
--   * permission inventory:consume (warehouse-scoped, ADMIN only; other roles only by the owner).

-- --- Prisma: table, indexes, foreign keys (as generated) -----------------------------------------

ALTER TABLE "inventory_movements" ADD COLUMN     "stock_issue_id" UUID;

CREATE TABLE "stock_issues" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID,
    "quantity" DECIMAL(19,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" UUID NOT NULL,

    CONSTRAINT "stock_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_issues_request_id_key" ON "stock_issues"("request_id");
CREATE INDEX "stock_issues_item_id_location_id_occurred_at_idx" ON "stock_issues"("item_id", "location_id", "occurred_at");
CREATE UNIQUE INDEX "inventory_movements_stock_issue_id_key" ON "inventory_movements"("stock_issue_id");

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_issue_id_fkey" FOREIGN KEY ("stock_issue_id") REFERENCES "stock_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_item_id_unit_id_fkey" FOREIGN KEY ("item_id", "unit_id") REFERENCES "inventory_items"("id", "base_unit_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Invariants ----------------------------------------------------------------------------------

ALTER TABLE "stock_issues"
  ADD CONSTRAINT "stock_issues_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "stock_issues_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

-- Only consumables; a lot exactly for lot-tracked items, of that item; the unit's scale.
CREATE FUNCTION stock_issues_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item record;
BEGIN
  SELECT "kind", "lot_tracking" INTO item FROM "inventory_items" WHERE "id" = NEW."item_id";
  IF item."kind" <> 'CONSUMABLE' THEN
    RAISE EXCEPTION 'AYVO: only a consumable is issued to consumption by hand'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (item."lot_tracking" = 'REQUIRED') <> (NEW."lot_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a lot is required exactly for lot-tracked items' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lot_id" IS NOT NULL
     AND (SELECT "item_id" FROM "inventory_lots" WHERE "id" = NEW."lot_id") <> NEW."item_id" THEN
    RAISE EXCEPTION 'AYVO: the lot belongs to another item' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_unit_scale(NEW."unit_id", NEW."quantity", 'issue quantity');
  RETURN NEW;
END
$$;
CREATE TRIGGER "stock_issues_check" BEFORE INSERT ON "stock_issues"
  FOR EACH ROW EXECUTE FUNCTION stock_issues_check();
CREATE TRIGGER "stock_issues_immutable" BEFORE UPDATE OR DELETE ON "stock_issues"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "stock_issues_no_truncate" BEFORE TRUNCATE ON "stock_issues"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- At commit: every issue has exactly its one movement (the unique index allows at most one).
CREATE FUNCTION stock_issues_has_movement() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "inventory_movements" WHERE "stock_issue_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a stock issue is posted to the ledger in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "stock_issues_has_movement" AFTER INSERT ON "stock_issues"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_issues_has_movement();

-- The movement's source: one more kind, and the stock issue column only for it.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_source_check";
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_source_check" CHECK (
    ("type" = 'RECEIPT' AND "quantity_delta" > 0 AND "receipt_line_id" IS NOT NULL
       AND "receipt_correction_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL
       AND "stock_issue_id" IS NULL)
    OR ("type" = 'RECEIPT_CORRECTION' AND "receipt_correction_id" IS NOT NULL
       AND "receipt_line_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL
       AND "stock_issue_id" IS NULL)
    OR ("type" IN ('LABEL_APPLICATION', 'FILL') AND "quantity_delta" < 0 AND "bottle_event_id" IS NOT NULL
       AND "bom_line_id" IS NOT NULL AND "receipt_line_id" IS NULL AND "receipt_correction_id" IS NULL
       AND "stock_issue_id" IS NULL)
    OR ("type" = 'CONSUMPTION_ISSUE' AND "quantity_delta" < 0 AND "stock_issue_id" IS NOT NULL
       AND "receipt_line_id" IS NULL AND "receipt_correction_id" IS NULL AND "bottle_event_id" IS NULL
       AND "bom_line_id" IS NULL));

-- The ledger trigger (as in 20261016090100, plus the CONSUMPTION_ISSUE branch).
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
  ELSIF NEW."type" = 'CONSUMPTION_ISSUE' THEN
    SELECT * INTO src FROM "stock_issues" WHERE "id" = NEW."stock_issue_id";
    IF src."item_id" <> NEW."item_id" OR src."lot_id" IS DISTINCT FROM NEW."lot_id"
       OR src."location_id" <> NEW."location_id" OR NEW."quantity_delta" <> -src."quantity" THEN
      RAISE EXCEPTION 'AYVO: a consumption issue movement must match its stock issue'
        USING ERRCODE = 'check_violation';
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

-- --- Permission ----------------------------------------------------------------------------------
SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('inventory:consume', 'Issue consumables (e.g. printer ribbon rolls) to consumption by hand, with a reason', true, false, false, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'inventory:consume');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
