-- Shared blank label stock and pieces per roll (owner 2026-10-27, doc 023 §4a).
-- 1. A LABEL_MEDIA component may name no product category: the shared blank label for every
--    product. Labels that name a category keep the check (a recipe uses only its own category's).
--    The product-specific part is the printed design (label templates, product label approvals);
--    stock is still consumed only by LABEL_APPLIED (one recipe line, never by printing).
-- 2. A LABEL_MEDIA component may hold its package capacity (pieces per roll) as an entry aid for
--    receipts. Stock and receipts stay in pcs: the capacity is never a unit or a conversion.
-- Both functions are replaced whole; only the marked conditions change. Existing rows are valid
-- under the new rules (they are only less strict).

CREATE OR REPLACE FUNCTION catalog_components_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item_kind "InventoryItemKind";
BEGIN
  SELECT "kind" INTO item_kind FROM "inventory_items" WHERE "id" = NEW."item_id";
  -- A liquid is made for one category. A label MAY name one (pre-printed); without one it is the
  -- shared blank label stock — the product's print is the label design, not the material.
  IF item_kind = 'BULK_LIQUID' AND NEW."category_code" IS NULL THEN
    RAISE EXCEPTION 'AYVO: a liquid component names its product category'
      USING ERRCODE = 'check_violation';
  END IF;
  IF item_kind = 'NEW_BOTTLE' AND NOT EXISTS (
       SELECT 1 FROM "inventory_items" WHERE "id" = NEW."item_id" AND "lot_tracking" = 'REQUIRED') THEN
    RAISE EXCEPTION 'AYVO: a bottle body component is lot-tracked' USING ERRCODE = 'check_violation';
  END IF;
  -- Packaging: bottles per package; labels: pieces per roll (an entry aid only — stock stays pcs).
  IF NEW."package_capacity" IS NOT NULL AND item_kind NOT IN ('PACKAGING', 'LABEL_MEDIA') THEN
    RAISE EXCEPTION 'AYVO: only packaging and labels have a package capacity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION recipe_revision_boms_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "RecipeStatus";
  last integer;
  bom_stage "ConsumptionStage";
  bom_code text;
  bom_version integer;
  expected_code text;
  category text;
  line record;
BEGIN
  SELECT "status" INTO st FROM "recipe_versions" WHERE "id" = NEW."recipe_version_id" FOR UPDATE;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'AYVO: only a draft recipe version is edited' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT max("revision") INTO last FROM "recipe_revisions"
    WHERE "recipe_version_id" = NEW."recipe_version_id";
  IF NEW."revision" IS DISTINCT FROM last THEN
    RAISE EXCEPTION 'AYVO: only the current revision of a draft gains BOMs'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Sealing: the BOM row lock serialises this link with any concurrent insert of a line into the
  -- same BOM (bom_lines_recipe_sealed takes a conflicting lock first). Lines committed before
  -- the lock are validated below; lines attempted after the link see it and are refused.
  SELECT "stage", "code", "version" INTO bom_stage, bom_code, bom_version
    FROM "bom_versions" WHERE "id" = NEW."bom_version_id" FOR UPDATE;
  IF bom_stage IS DISTINCT FROM NEW."stage" THEN
    RAISE EXCEPTION 'AYVO: a recipe BOM has the stage it is linked for' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the recipe's own BOM (R-<PRODUCT>-V<n>-LA/-FL, version = revision) — never a global
  -- stage rule such as LABEL_APPLICATION v1, which activeBom would then stop finding.
  SELECT 'R-' || p."code" || '-V' || v."version" || '-'
         || CASE NEW."stage" WHEN 'LABEL_APPLICATION' THEN 'LA' ELSE 'FL' END
    INTO expected_code
    FROM "recipe_versions" v JOIN "products" p ON p."id" = v."product_id"
    WHERE v."id" = NEW."recipe_version_id";
  IF bom_code IS DISTINCT FROM expected_code OR bom_version IS DISTINCT FROM NEW."revision" THEN
    RAISE EXCEPTION 'AYVO: a recipe links only its own BOM (%, version %)', expected_code, NEW."revision"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "category_code" INTO category FROM "recipe_revisions"
    WHERE "recipe_version_id" = NEW."recipe_version_id" AND "revision" = NEW."revision";
  IF NOT EXISTS (SELECT 1 FROM "bom_lines" WHERE "bom_version_id" = NEW."bom_version_id") THEN
    RAISE EXCEPTION 'AYVO: a recipe BOM has at least one line' USING ERRCODE = 'check_violation';
  END IF;
  FOR line IN
    SELECT i."kind", i."lot_tracking", i."archived_at", u."dimension", u."code" AS unit_code,
           l."quantity", c."category_code" AS component_category
      FROM "bom_lines" l
      JOIN "inventory_items" i ON i."id" = l."item_id"
      JOIN "inventory_units" u ON u."id" = l."unit_id"
      LEFT JOIN "catalog_components" c ON c."item_id" = i."id"
      WHERE l."bom_version_id" = NEW."bom_version_id"
  LOOP
    IF NOT ((NEW."stage" = 'LABEL_APPLICATION' AND line."kind" IN ('NEW_BOTTLE', 'LABEL_MEDIA'))
            OR (NEW."stage" = 'FILL' AND line."kind" IN ('BULK_LIQUID', 'PUMP'))) THEN
      RAISE EXCEPTION 'AYVO: component kind % does not belong to stage %', line."kind", NEW."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (line."kind" = 'BULK_LIQUID' AND line."dimension" <> 'VOLUME')
       OR (line."kind" <> 'BULK_LIQUID' AND line."unit_code" <> 'pcs') THEN
      RAISE EXCEPTION 'AYVO: component kind % is not measured in unit %', line."kind", line."unit_code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF line."archived_at" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a recipe uses no archived item' USING ERRCODE = 'check_violation';
    END IF;
    -- Label application consumes the bottle body from the lot the operator selects (doc 018).
    IF line."kind" = 'NEW_BOTTLE' AND line."lot_tracking" <> 'REQUIRED' THEN
      RAISE EXCEPTION 'AYVO: the bottle body of a recipe is lot-tracked' USING ERRCODE = 'check_violation';
    END IF;
    IF line."kind" = 'NEW_BOTTLE' AND line."quantity" <> 1 THEN
      RAISE EXCEPTION 'AYVO: a finished bottle has exactly one bottle body' USING ERRCODE = 'check_violation';
    END IF;
    -- A liquid always matches the product's category; a label (or anything else) only when it
    -- names one — the shared blank label names none.
    IF (line."kind" = 'BULK_LIQUID' AND line.component_category IS DISTINCT FROM category)
       OR (line.component_category IS NOT NULL AND line.component_category <> category) THEN
      RAISE EXCEPTION 'AYVO: component is not made for product category %', category
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "bom_lines" l JOIN "inventory_items" i ON i."id" = l."item_id"
      WHERE l."bom_version_id" = NEW."bom_version_id"
         OR l."bom_version_id" IN (SELECT "bom_version_id" FROM "recipe_revision_boms"
                                   WHERE "recipe_version_id" = NEW."recipe_version_id"
                                     AND "revision" = NEW."revision")
      GROUP BY i."kind" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'AYVO: a recipe has one line per component kind' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
