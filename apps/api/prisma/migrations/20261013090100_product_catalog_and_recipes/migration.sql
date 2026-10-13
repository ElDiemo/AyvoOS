-- Product catalogue and recipes v0.1 (doc 023). Additive only: new tables, one new trigger on
-- bom_lines (recipe BOMs are sealed once linked), new permissions and their grants. No existing
-- row is changed; no product, recipe, component, crate type or stock is invented. Seeds contain
-- only the two confirmed product categories (doc 020 §13).

-- CreateEnum
CREATE TYPE "RecipeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "product_categories" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "catalog_components" (
    "item_id" UUID NOT NULL,
    "category_code" TEXT,
    "package_capacity" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "catalog_components_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "crate_types" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "crate_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_type_categories" (
    "crate_type_id" UUID NOT NULL,
    "category_code" TEXT NOT NULL,

    CONSTRAINT "crate_type_categories_pkey" PRIMARY KEY ("crate_type_id","category_code")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "nominal_quantity" DECIMAL(19,3) NOT NULL,
    "nominal_unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "product_id" UUID NOT NULL,
    "category_code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RecipeStatus" NOT NULL DEFAULT 'DRAFT',
    "based_on_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "activated_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" UUID,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_revisions" (
    "recipe_version_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "category_code" TEXT NOT NULL,
    "crate_type_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "recipe_revisions_pkey" PRIMARY KEY ("recipe_version_id","revision")
);

-- CreateTable
CREATE TABLE "recipe_revision_boms" (
    "recipe_version_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "stage" "ConsumptionStage" NOT NULL,
    "bom_version_id" UUID NOT NULL,

    CONSTRAINT "recipe_revision_boms_pkey" PRIMARY KEY ("recipe_version_id","revision","stage")
);

-- CreateIndex
CREATE UNIQUE INDEX "crate_types_code_key" ON "crate_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE UNIQUE INDEX "products_id_category_code_key" ON "products"("id", "category_code");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_product_id_version_key" ON "recipe_versions"("product_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_id_product_id_key" ON "recipe_versions"("id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_id_category_code_key" ON "recipe_versions"("id", "category_code");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_revision_boms_bom_version_id_key" ON "recipe_revision_boms"("bom_version_id");

-- AddForeignKey
ALTER TABLE "catalog_components" ADD CONSTRAINT "catalog_components_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_components" ADD CONSTRAINT "catalog_components_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "product_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_components" ADD CONSTRAINT "catalog_components_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_components" ADD CONSTRAINT "catalog_components_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_types" ADD CONSTRAINT "crate_types_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_types" ADD CONSTRAINT "crate_types_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_categories" ADD CONSTRAINT "crate_type_categories_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_categories" ADD CONSTRAINT "crate_type_categories_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "product_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "product_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_nominal_unit_id_fkey" FOREIGN KEY ("nominal_unit_id") REFERENCES "inventory_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_product_id_category_code_fkey" FOREIGN KEY ("product_id", "category_code") REFERENCES "products"("id", "category_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_based_on_id_product_id_fkey" FOREIGN KEY ("based_on_id", "product_id") REFERENCES "recipe_versions"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revisions" ADD CONSTRAINT "recipe_revisions_recipe_version_id_category_code_fkey" FOREIGN KEY ("recipe_version_id", "category_code") REFERENCES "recipe_versions"("id", "category_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revisions" ADD CONSTRAINT "recipe_revisions_crate_type_id_category_code_fkey" FOREIGN KEY ("crate_type_id", "category_code") REFERENCES "crate_type_categories"("crate_type_id", "category_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revisions" ADD CONSTRAINT "recipe_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revisions" ADD CONSTRAINT "recipe_revisions_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revision_boms" ADD CONSTRAINT "recipe_revision_boms_recipe_version_id_revision_fkey" FOREIGN KEY ("recipe_version_id", "revision") REFERENCES "recipe_revisions"("recipe_version_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_revision_boms" ADD CONSTRAINT "recipe_revision_boms_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "bom_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Invariants (doc 023 §6)
-- =============================================================================================

-- --- Product categories: confirmed reference data -----------------------------------------------

ALTER TABLE "product_categories"
  ADD CONSTRAINT "product_categories_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  ADD CONSTRAINT "product_categories_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200);
CREATE TRIGGER "product_categories_immutable" BEFORE UPDATE OR DELETE ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "product_categories_no_truncate" BEFORE TRUNCATE ON "product_categories"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

INSERT INTO "product_categories" ("code", "name") VALUES
  ('HAND_SOAP', 'Tekuté mýdlo'),
  ('SHOWER_GEL', 'Sprchový gel');

-- --- Catalogue components (profiles of inventory items) ------------------------------------------

ALTER TABLE "catalog_components"
  ADD CONSTRAINT "catalog_components_package_capacity_check"
    CHECK ("package_capacity" IS NULL OR "package_capacity" BETWEEN 1 AND 100000);
CREATE FUNCTION catalog_components_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item_kind "InventoryItemKind";
BEGIN
  SELECT "kind" INTO item_kind FROM "inventory_items" WHERE "id" = NEW."item_id";
  IF item_kind IN ('BULK_LIQUID', 'LABEL_MEDIA') AND NEW."category_code" IS NULL THEN
    RAISE EXCEPTION 'AYVO: a liquid or label component names its product category'
      USING ERRCODE = 'check_violation';
  END IF;
  IF item_kind = 'NEW_BOTTLE' AND NOT EXISTS (
       SELECT 1 FROM "inventory_items" WHERE "id" = NEW."item_id" AND "lot_tracking" = 'REQUIRED') THEN
    RAISE EXCEPTION 'AYVO: a bottle body component is lot-tracked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."package_capacity" IS NOT NULL AND item_kind <> 'PACKAGING' THEN
    RAISE EXCEPTION 'AYVO: only packaging has a package capacity' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "catalog_components_check" BEFORE INSERT ON "catalog_components"
  FOR EACH ROW EXECUTE FUNCTION catalog_components_check();
CREATE TRIGGER "catalog_components_immutable" BEFORE UPDATE OR DELETE ON "catalog_components"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "catalog_components_no_truncate" BEFORE TRUNCATE ON "catalog_components"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Crate types (ADR 0021: capacity is data) ----------------------------------------------------

ALTER TABLE "crate_types"
  ADD CONSTRAINT "crate_types_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  ADD CONSTRAINT "crate_types_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "crate_types_capacity_check" CHECK ("capacity" BETWEEN 1 AND 1000);
CREATE TRIGGER "crate_types_immutable" BEFORE UPDATE OR DELETE ON "crate_types"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_types_no_truncate" BEFORE TRUNCATE ON "crate_types"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_categories_immutable" BEFORE UPDATE OR DELETE ON "crate_type_categories"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_categories_no_truncate" BEFORE TRUNCATE ON "crate_type_categories"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- A crate type carries at least one category (checked at commit).
CREATE FUNCTION crate_types_has_category() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_type_categories" WHERE "crate_type_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a crate type carries at least one product category'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "crate_types_has_category" AFTER INSERT ON "crate_types"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crate_types_has_category();

-- --- Products ---------------------------------------------------------------------------------

ALTER TABLE "products"
  ADD CONSTRAINT "products_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,23}$'),
  ADD CONSTRAINT "products_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "products_nominal_quantity_check" CHECK ("nominal_quantity" > 0);
CREATE FUNCTION products_scale() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_unit_scale(NEW."nominal_unit_id", NEW."nominal_quantity", 'nominal quantity');
  RETURN NEW;
END
$$;
CREATE TRIGGER "products_scale" BEFORE INSERT ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_scale();
CREATE TRIGGER "products_immutable" BEFORE UPDATE OR DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "products_no_truncate" BEFORE TRUNCATE ON "products"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Recipe versions --------------------------------------------------------------------------

ALTER TABLE "recipe_versions"
  ADD CONSTRAINT "recipe_versions_version_check" CHECK ("version" BETWEEN 1 AND 9999),
  ADD CONSTRAINT "recipe_versions_based_on_check" CHECK ("based_on_id" IS NULL OR "based_on_id" <> "id"),
  ADD CONSTRAINT "recipe_versions_status_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "activated_by" IS NULL
       AND "archived_at" IS NULL AND "archived_by" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "activated_by" IS NOT NULL
       AND "archived_at" IS NULL AND "archived_by" IS NULL)
    OR ("status" = 'ARCHIVED' AND "archived_at" IS NOT NULL AND "archived_by" IS NOT NULL
       AND ("activated_at" IS NULL) = ("activated_by" IS NULL)));

-- At most one active version per product.
CREATE UNIQUE INDEX "recipe_versions_one_active" ON "recipe_versions" ("product_id")
  WHERE "status" = 'ACTIVE';

-- An active recipe is complete: a crate type, and exactly one bottle, liquid, pump and label
-- line (doc 023 §4) in its current revision, none of them archived.
CREATE FUNCTION ayvo_assert_recipe_complete(p_recipe_version_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  rev integer;
  crate uuid;
  kinds text[];
  archived integer;
BEGIN
  SELECT "revision", "crate_type_id" INTO rev, crate FROM "recipe_revisions"
    WHERE "recipe_version_id" = p_recipe_version_id ORDER BY "revision" DESC LIMIT 1;
  IF rev IS NULL THEN
    RAISE EXCEPTION 'AYVO: a recipe version has no content' USING ERRCODE = 'check_violation';
  END IF;
  IF crate IS NULL THEN
    RAISE EXCEPTION 'AYVO: an active recipe names its crate type' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(i."kind"::text ORDER BY i."kind"::text),
         count(*) FILTER (WHERE i."archived_at" IS NOT NULL)
    INTO kinds, archived
    FROM "recipe_revision_boms" rb
    JOIN "bom_lines" l ON l."bom_version_id" = rb."bom_version_id"
    JOIN "inventory_items" i ON i."id" = l."item_id"
    WHERE rb."recipe_version_id" = p_recipe_version_id AND rb."revision" = rev;
  IF kinds IS DISTINCT FROM ARRAY['BULK_LIQUID', 'LABEL_MEDIA', 'NEW_BOTTLE', 'PUMP'] THEN
    RAISE EXCEPTION 'AYVO: an active recipe has exactly one bottle, liquid, pump and label line'
      USING ERRCODE = 'check_violation';
  END IF;
  IF archived > 0 THEN
    RAISE EXCEPTION 'AYVO: an active recipe uses no archived item' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION recipe_versions_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'AYVO: a recipe version starts as a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "recipe_versions_insert" BEFORE INSERT ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION recipe_versions_insert();

-- Forward-only status; nothing else ever changes. Activation re-checks completeness.
CREATE FUNCTION recipe_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: recipe versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."product_id" <> OLD."product_id"
     OR NEW."category_code" <> OLD."category_code" OR NEW."version" <> OLD."version"
     OR NEW."based_on_id" IS DISTINCT FROM OLD."based_on_id"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" <> OLD."created_by"
     OR NEW."operation_request_id" <> OLD."operation_request_id" THEN
    RAISE EXCEPTION 'AYVO: recipe version identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'ARCHIVED'))
          OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'AYVO: recipe status moves forward only (DRAFT → ACTIVE → ARCHIVED)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ACTIVE' AND (NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
                                  OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by") THEN
    RAISE EXCEPTION 'AYVO: the activation of a recipe version is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> 'ACTIVE' AND (NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
                                   OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by") THEN
    RAISE EXCEPTION 'AYVO: only activation records an activation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    PERFORM ayvo_assert_recipe_complete(NEW."id");
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "recipe_versions_guard" BEFORE UPDATE OR DELETE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION recipe_versions_guard();
CREATE TRIGGER "recipe_versions_no_truncate" BEFORE TRUNCATE ON "recipe_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Every recipe version has content from the start (revision 1, checked at commit).
CREATE FUNCTION recipe_versions_has_revision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "recipe_revisions"
                 WHERE "recipe_version_id" = NEW."id" AND "revision" = 1) THEN
    RAISE EXCEPTION 'AYVO: a recipe version is created with its first revision'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "recipe_versions_has_revision" AFTER INSERT ON "recipe_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recipe_versions_has_revision();

-- --- Recipe revisions: append-only, consecutive, only while DRAFT --------------------------------

ALTER TABLE "recipe_revisions"
  ADD CONSTRAINT "recipe_revisions_revision_check" CHECK ("revision" >= 1);
CREATE FUNCTION recipe_revisions_append() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "RecipeStatus";
  last integer;
BEGIN
  -- The version row lock serialises edits with activation and archiving.
  SELECT "status" INTO st FROM "recipe_versions" WHERE "id" = NEW."recipe_version_id" FOR UPDATE;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'AYVO: only a draft recipe version is edited' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT coalesce(max("revision"), 0) INTO last FROM "recipe_revisions"
    WHERE "recipe_version_id" = NEW."recipe_version_id";
  IF NEW."revision" <> last + 1 THEN
    RAISE EXCEPTION 'AYVO: recipe revisions are consecutive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "recipe_revisions_append" BEFORE INSERT ON "recipe_revisions"
  FOR EACH ROW EXECUTE FUNCTION recipe_revisions_append();
CREATE TRIGGER "recipe_revisions_immutable" BEFORE UPDATE OR DELETE ON "recipe_revisions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "recipe_revisions_no_truncate" BEFORE TRUNCATE ON "recipe_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Recipe BOMs: stage, component kind, unit dimension, category ---------------------------------
--
-- LABEL_APPLICATION: bottle body (exactly 1 pcs) and label (pcs); FILL: liquid (a volume unit)
-- and pump (pcs).
-- Liquid and label must be made for the product's category; any component that names a category
-- must name the product's. No component kind (hence no item) twice in one revision.
CREATE FUNCTION recipe_revision_boms_check() RETURNS trigger
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
  SELECT "stage", "code", "version" INTO bom_stage, bom_code, bom_version
    FROM "bom_versions" WHERE "id" = NEW."bom_version_id";
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
    IF (line."kind" IN ('BULK_LIQUID', 'LABEL_MEDIA') AND line.component_category IS DISTINCT FROM category)
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
CREATE TRIGGER "recipe_revision_boms_check" BEFORE INSERT ON "recipe_revision_boms"
  FOR EACH ROW EXECUTE FUNCTION recipe_revision_boms_check();
CREATE TRIGGER "recipe_revision_boms_immutable" BEFORE UPDATE OR DELETE ON "recipe_revision_boms"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "recipe_revision_boms_no_truncate" BEFORE TRUNCATE ON "recipe_revision_boms"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- A recipe BOM is sealed once linked: no line can be added afterwards. (Lines already reject
-- UPDATE and DELETE; legacy stage rules are not linked and are unaffected.)
CREATE FUNCTION bom_lines_recipe_sealed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "recipe_revision_boms" WHERE "bom_version_id" = NEW."bom_version_id") THEN
    RAISE EXCEPTION 'AYVO: a recipe BOM is sealed once linked to its recipe'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bom_lines_recipe_sealed" BEFORE INSERT ON "bom_lines"
  FOR EACH ROW EXECUTE FUNCTION bom_lines_recipe_sealed();

-- =============================================================================================
-- Permissions (doc 021 §4, doc 023 §8): company-wide catalogue, not site- or warehouse-scoped.
-- ADMIN holds every permission explicitly; changing the catalogue stays an ADMIN decision (like
-- company-wide label templates); operational roles read it.
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped") VALUES
  ('catalog:read', 'Read the company-wide product catalogue, recipes and material requirements', false, false, false),
  ('catalog:manage', 'Create catalogue components, crate types, products and recipe drafts', false, false, false),
  ('catalog:recipes_activate', 'Activate and archive recipe versions', false, false, false);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'catalog:read'),
  ('ADMIN', 'catalog:manage'),
  ('ADMIN', 'catalog:recipes_activate'),
  ('PRODUCTION_SUPERVISOR', 'catalog:read'),
  ('PRODUCTION_OPERATOR', 'catalog:read'),
  ('WAREHOUSE_SUPERVISOR', 'catalog:read');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
