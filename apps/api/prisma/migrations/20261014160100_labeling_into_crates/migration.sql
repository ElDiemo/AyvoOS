-- Labelling into crates (doc 025 A3; owner decisions B1–B4, 2026-10-14). Additive: new tables,
-- new nullable columns on bottle_events, crate_events and workstation_sessions (existing rows stay
-- NULL, no backfill), product label approvals, the rule that a NEW label application needs a
-- crate cycle (closes the standalone path; existing LABEL_APPLIED rows are untouched), and the
-- operator's labelling permission (B4). No product, approval, cycle or bottle is created.

-- CreateEnum
CREATE TYPE "CrateCycleStatus" AS ENUM ('OPEN_ASSEMBLY', 'READY_TO_FILL', 'FILLING', 'FILLED', 'ABORTED');

-- CreateEnum
CREATE TYPE "CrateAssignmentSource" AS ENUM ('LABELING');











-- AlterTable
ALTER TABLE "bottle_events" ADD COLUMN     "crate_cycle_id" UUID,
ADD COLUMN     "operation_request_id" UUID,
ADD COLUMN     "workstation_session_id" UUID;

-- AlterTable
ALTER TABLE "crate_events" ADD COLUMN     "cycle_id" UUID;

-- AlterTable
ALTER TABLE "workstation_sessions" ADD COLUMN     "crate_id" UUID,
ADD COLUMN     "labeling_context_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "label_template_version_id" UUID,
ADD COLUMN     "product_id" UUID,
ADD COLUMN     "recipe_version_id" UUID,
ADD COLUMN     "source_lot_id" UUID;

-- CreateTable
CREATE TABLE "product_label_approvals" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "product_id" UUID NOT NULL,
    "label_template_version_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID NOT NULL,
    "approve_operation_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason" TEXT,
    "revoke_operation_id" UUID,

    CONSTRAINT "product_label_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_cycles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "crate_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "CrateCycleStatus" NOT NULL DEFAULT 'OPEN_ASSEMBLY',
    "crate_type_id" UUID NOT NULL,
    "capacity" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "category_code" TEXT NOT NULL,
    "recipe_version_id" UUID NOT NULL,
    "label_template_version_id" UUID NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID NOT NULL,
    "open_operation_id" UUID NOT NULL,
    "ready_to_fill_at" TIMESTAMPTZ(3),
    "aborted_at" TIMESTAMPTZ(3),
    "aborted_by" UUID,
    "abort_reason" TEXT,

    CONSTRAINT "crate_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_assignments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "cycle_id" UUID NOT NULL,
    "cycle_capacity" INTEGER NOT NULL,
    "bottle_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source" "CrateAssignmentSource" NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "assigned_event_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "released_by" UUID,
    "release_reason" TEXT,
    "release_operation_id" UUID,

    CONSTRAINT "crate_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bottle_product_bindings" (
    "bottle_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "category_code" TEXT NOT NULL,
    "label_template_version_id" UUID NOT NULL,
    "label_applied_event_id" UUID NOT NULL,
    "crate_cycle_id" UUID NOT NULL,
    "bound_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "bottle_product_bindings_pkey" PRIMARY KEY ("bottle_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_label_approvals_approve_operation_id_key" ON "product_label_approvals"("approve_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_label_approvals_revoke_operation_id_key" ON "product_label_approvals"("revoke_operation_id");

-- CreateIndex
CREATE INDEX "product_label_approvals_product_id_idx" ON "product_label_approvals"("product_id");

-- CreateIndex
CREATE INDEX "crate_cycles_crate_id_opened_at_idx" ON "crate_cycles"("crate_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "crate_cycles_id_capacity_key" ON "crate_cycles"("id", "capacity");

-- CreateIndex
CREATE UNIQUE INDEX "crate_assignments_assigned_event_id_key" ON "crate_assignments"("assigned_event_id");

-- CreateIndex
CREATE INDEX "crate_assignments_cycle_id_idx" ON "crate_assignments"("cycle_id");

-- CreateIndex
CREATE INDEX "crate_assignments_bottle_id_idx" ON "crate_assignments"("bottle_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottle_product_bindings_label_applied_event_id_key" ON "bottle_product_bindings"("label_applied_event_id");

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_crate_cycle_id_fkey" FOREIGN KEY ("crate_cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_workstation_session_id_fkey" FOREIGN KEY ("workstation_session_id") REFERENCES "workstation_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_events" ADD CONSTRAINT "crate_events_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_source_lot_id_fkey" FOREIGN KEY ("source_lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_sessions" ADD CONSTRAINT "workstation_sessions_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_approve_operation_id_fkey" FOREIGN KEY ("approve_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_label_approvals" ADD CONSTRAINT "product_label_approvals_revoke_operation_id_fkey" FOREIGN KEY ("revoke_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_recipe_version_id_fkey" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_aborted_by_fkey" FOREIGN KEY ("aborted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycles" ADD CONSTRAINT "crate_cycles_open_operation_id_fkey" FOREIGN KEY ("open_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_cycle_id_cycle_capacity_fkey" FOREIGN KEY ("cycle_id", "cycle_capacity") REFERENCES "crate_cycles"("id", "capacity") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_release_operation_id_fkey" FOREIGN KEY ("release_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_assigned_event_id_fkey" FOREIGN KEY ("assigned_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_label_template_version_id_fkey" FOREIGN KEY ("label_template_version_id") REFERENCES "label_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_label_applied_event_id_fkey" FOREIGN KEY ("label_applied_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_crate_cycle_id_fkey" FOREIGN KEY ("crate_cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_product_bindings" ADD CONSTRAINT "bottle_product_bindings_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Product label approvals (owner B1): one open approval per label design
-- =============================================================================================

CREATE UNIQUE INDEX "product_label_approvals_one_open_per_design"
  ON "product_label_approvals" ("label_template_version_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "product_label_approvals"
  ADD CONSTRAINT "product_label_approvals_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "product_label_approvals_revoke_check" CHECK (
    ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
    AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
    AND ("revoked_at" IS NULL) = ("revoke_operation_id" IS NULL)
    AND ("revoke_reason" IS NULL OR length(btrim("revoke_reason")) BETWEEN 3 AND 500));

CREATE FUNCTION product_label_approvals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: label approvals are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revoke_reason','revoke_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revoke_reason','revoke_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: a label approval changes only by its one revocation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "product_label_approvals_guard" BEFORE UPDATE OR DELETE ON "product_label_approvals"
  FOR EACH ROW EXECUTE FUNCTION product_label_approvals_guard();
CREATE TRIGGER "product_label_approvals_no_truncate" BEFORE TRUNCATE ON "product_label_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Crate cycles (ADR 0021, ADR 0025 proposed)
-- =============================================================================================

CREATE UNIQUE INDEX "crate_cycles_one_open_per_crate"
  ON "crate_cycles" ("crate_id") WHERE "status" <> 'ABORTED';

ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_capacity_check" CHECK ("capacity" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "crate_cycles_member_count_check" CHECK ("member_count" BETWEEN 0 AND "capacity"),
  ADD CONSTRAINT "crate_cycles_abort_check" CHECK (
    ("status" = 'ABORTED') = ("aborted_at" IS NOT NULL)
    AND ("aborted_at" IS NULL) = ("aborted_by" IS NULL)
    AND ("aborted_at" IS NULL) = ("abort_reason" IS NULL));

-- The snapshot is consistent with the crate, its type, the product and the recipe at opening.
CREATE FUNCTION crate_cycles_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'OPEN_ASSEMBLY' OR NEW."member_count" <> 0 THEN
    RAISE EXCEPTION 'AYVO: a crate cycle opens empty, in OPEN_ASSEMBLY' USING ERRCODE = 'check_violation';
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
  -- A NEW cycle starts only with the product's current ACTIVE recipe of an active product (owner
  -- B2: an open cycle keeps its snapshot, a new one never takes a stale or archived recipe).
  IF NOT EXISTS (SELECT 1 FROM "products" p JOIN "recipe_versions" r ON r."product_id" = p."id"
                  WHERE p."id" = NEW."product_id" AND p."status" = 'ACTIVE'
                    AND r."id" = NEW."recipe_version_id" AND r."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'AYVO: a new crate cycle needs the product''s active recipe of an active product'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The crate type is exactly the one of that recipe (its latest, sealed revision), not just a
  -- type of the same category.
  IF NEW."crate_type_id" IS DISTINCT FROM (
       SELECT rr."crate_type_id" FROM "recipe_revisions" rr
        WHERE rr."recipe_version_id" = NEW."recipe_version_id"
        ORDER BY rr."revision" DESC LIMIT 1) THEN
    RAISE EXCEPTION 'AYVO: the crate type differs from the crate type of the recipe' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Snapshot immutable; status only along the approved transitions (doc 025 §3.2).
CREATE FUNCTION crate_cycles_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: crate cycles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','member_count','ready_to_fill_at','aborted_at','aborted_by','abort_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','member_count','ready_to_fill_at','aborted_at','aborted_by','abort_reason']) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" = 'FILLING')) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'ABORTED' THEN
    RAISE EXCEPTION 'AYVO: an aborted crate cycle never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- member_count = active assignments; OPEN_ASSEMBLY below capacity, READY_TO_FILL exactly at it
-- (with its event); ABORTED empty — at commit, against the whole transaction.
CREATE FUNCTION ayvo_assert_crate_cycle(p_cycle_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle record;
  active int;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*) INTO active FROM "crate_assignments"
   WHERE "cycle_id" = p_cycle_id AND "released_at" IS NULL;
  IF cycle."member_count" <> active THEN
    RAISE EXCEPTION 'AYVO: cycle member count % differs from % active assignments', cycle."member_count", active
      USING ERRCODE = 'check_violation';
  END IF;
  IF (cycle."status" = 'OPEN_ASSEMBLY' AND active >= cycle."capacity")
     OR (cycle."status" = 'READY_TO_FILL' AND active <> cycle."capacity")
     OR (cycle."status" = 'ABORTED' AND active <> 0) THEN
    RAISE EXCEPTION 'AYVO: cycle status % does not match % of % members', cycle."status", active, cycle."capacity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'READY_TO_FILL' AND (cycle."ready_to_fill_at" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'READY_TO_FILL')) THEN
    RAISE EXCEPTION 'AYVO: READY_TO_FILL without its event' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION crate_cycles_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_crate_cycle(NEW."id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "crate_cycles_insert_check" BEFORE INSERT ON "crate_cycles"
  FOR EACH ROW EXECUTE FUNCTION crate_cycles_insert_check();
CREATE TRIGGER "crate_cycles_guard" BEFORE UPDATE OR DELETE ON "crate_cycles"
  FOR EACH ROW EXECUTE FUNCTION crate_cycles_guard();
CREATE TRIGGER "crate_cycles_no_truncate" BEFORE TRUNCATE ON "crate_cycles"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "crate_cycles_consistent" AFTER INSERT OR UPDATE ON "crate_cycles"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crate_cycles_consistent();

-- =============================================================================================
-- Crate assignments: membership with an ordinal; one active per bottle and per ordinal
-- =============================================================================================

CREATE UNIQUE INDEX "crate_assignments_one_active_per_bottle"
  ON "crate_assignments" ("bottle_id") WHERE "released_at" IS NULL;
CREATE UNIQUE INDEX "crate_assignments_one_active_per_ordinal"
  ON "crate_assignments" ("cycle_id", "ordinal") WHERE "released_at" IS NULL;

ALTER TABLE "crate_assignments"
  ADD CONSTRAINT "crate_assignments_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND "cycle_capacity"),
  ADD CONSTRAINT "crate_assignments_release_check" CHECK (
    ("released_at" IS NULL) = ("released_by" IS NULL)
    AND ("released_at" IS NULL) = ("release_reason" IS NULL)
    AND ("released_at" IS NULL) = ("release_operation_id" IS NULL));

CREATE FUNCTION crate_assignments_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: an assignment starts active' USING ERRCODE = 'check_violation';
  END IF;
  -- A3: the labelling scan assigns only into an assembling crate (doc 025 §3.2).
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c
                  WHERE c."id" = NEW."cycle_id" AND c."status" = 'OPEN_ASSEMBLY') THEN
    RAISE EXCEPTION 'AYVO: bottles are assigned only to an OPEN_ASSEMBLY cycle' USING ERRCODE = 'check_violation';
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

CREATE FUNCTION crate_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: assignments are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason','release_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason','release_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: an assignment changes only by its one release' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The member's product binding matches the cycle snapshot (checked at commit, after the binding).
CREATE FUNCTION crate_assignments_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c JOIN "bottle_product_bindings" pb ON pb."bottle_id" = NEW."bottle_id"
                  WHERE c."id" = NEW."cycle_id" AND pb."product_id" = c."product_id"
                    AND pb."label_template_version_id" = c."label_template_version_id") THEN
    RAISE EXCEPTION 'AYVO: a crate member must be bound to the cycle''s product and label design'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_crate_cycle(NEW."cycle_id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "crate_assignments_insert_check" BEFORE INSERT ON "crate_assignments"
  FOR EACH ROW EXECUTE FUNCTION crate_assignments_insert_check();
CREATE TRIGGER "crate_assignments_guard" BEFORE UPDATE OR DELETE ON "crate_assignments"
  FOR EACH ROW EXECUTE FUNCTION crate_assignments_guard();
CREATE TRIGGER "crate_assignments_no_truncate" BEFORE TRUNCATE ON "crate_assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "crate_assignments_consistent" AFTER INSERT OR UPDATE ON "crate_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crate_assignments_consistent();

-- =============================================================================================
-- Bottle product bindings (owner B1): once, at the labelling scan, never changed
-- =============================================================================================

CREATE FUNCTION bottle_product_bindings_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "bottle_events" e
                  WHERE e."id" = NEW."label_applied_event_id" AND e."bottle_id" = NEW."bottle_id"
                    AND e."type" = 'LABEL_APPLIED' AND e."crate_cycle_id" = NEW."crate_cycle_id") THEN
    RAISE EXCEPTION 'AYVO: a product binding is made by the bottle''s LABEL_APPLIED in this cycle'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "crate_cycles" c
                  WHERE c."id" = NEW."crate_cycle_id" AND c."product_id" = NEW."product_id"
                    AND c."category_code" = NEW."category_code"
                    AND c."label_template_version_id" = NEW."label_template_version_id") THEN
    RAISE EXCEPTION 'AYVO: the binding differs from the cycle snapshot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottle_product_bindings_insert_check" BEFORE INSERT ON "bottle_product_bindings"
  FOR EACH ROW EXECUTE FUNCTION bottle_product_bindings_insert_check();
CREATE TRIGGER "bottle_product_bindings_immutable" BEFORE UPDATE OR DELETE ON "bottle_product_bindings"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bottle_product_bindings_no_truncate" BEFORE TRUNCATE ON "bottle_product_bindings"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Bottle events: a NEW label application happens only into a crate cycle at a station (closes
-- the standalone path at the database); existing rows are untouched.
-- =============================================================================================

CREATE FUNCTION bottle_events_cycle_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'LABEL_APPLIED' AND (NEW."crate_cycle_id" IS NULL OR NEW."workstation_session_id" IS NULL
                                       OR NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a label is applied only into a crate cycle at a workstation (doc 025 A3)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'ASSIGNED_TO_CRATE' AND NEW."crate_cycle_id" IS NULL THEN
    RAISE EXCEPTION 'AYVO: ASSIGNED_TO_CRATE names its crate cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottle_events_cycle_rules" BEFORE INSERT ON "bottle_events"
  FOR EACH ROW EXECUTE FUNCTION bottle_events_cycle_rules();

-- A labelling LABEL_APPLIED (with a cycle) leaves the bottle bound and in that cycle at commit.
CREATE FUNCTION bottle_events_labeling_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'LABEL_APPLIED' AND NEW."crate_cycle_id" IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM "bottle_product_bindings" pb WHERE pb."label_applied_event_id" = NEW."id")
    OR NOT EXISTS (SELECT 1 FROM "crate_assignments" a
                    WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id")) THEN
    RAISE EXCEPTION 'AYVO: a labelling scan binds the bottle and assigns it to the crate'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "bottle_events_labeling_complete" AFTER INSERT ON "bottle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottle_events_labeling_complete();

-- =============================================================================================
-- Crate events: cycle events name their cycle, which belongs to the crate
-- =============================================================================================

ALTER TABLE "crate_events" DROP CONSTRAINT "crate_events_reference_check";
ALTER TABLE "crate_events"
  ADD CONSTRAINT "crate_events_reference_check"
    CHECK (CASE "type"
             WHEN 'REGISTERED' THEN "registration_id" IS NOT NULL AND "print_job_id" IS NULL AND "cycle_id" IS NULL
             WHEN 'LABEL_PRINT_JOB_CREATED' THEN "print_job_id" IS NOT NULL AND "registration_id" IS NULL AND "cycle_id" IS NULL
             ELSE "cycle_id" IS NOT NULL AND "registration_id" IS NULL AND "print_job_id" IS NULL
           END);

CREATE FUNCTION crate_events_cycle_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."cycle_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_cycles" c WHERE c."id" = NEW."cycle_id" AND c."crate_id" = NEW."crate_id") THEN
    RAISE EXCEPTION 'AYVO: crate event references a cycle of another crate' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "crate_events_cycle_check" BEFORE INSERT ON "crate_events"
  FOR EACH ROW EXECUTE FUNCTION crate_events_cycle_check();

-- =============================================================================================
-- Work sessions: the labelling context exists only at a labelling station; one active session
-- per loaded crate (two stations never fill the same crate unknowingly).
-- =============================================================================================

CREATE UNIQUE INDEX "workstation_sessions_one_active_per_crate"
  ON "workstation_sessions" ("crate_id") WHERE "status" = 'ACTIVE' AND "crate_id" IS NOT NULL;

CREATE FUNCTION workstation_sessions_context_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW."product_id" IS NOT NULL OR NEW."recipe_version_id" IS NOT NULL
      OR NEW."label_template_version_id" IS NOT NULL OR NEW."source_lot_id" IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "workstations" w
                      WHERE w."id" = NEW."workstation_id" AND w."mode" = 'LABELING') THEN
    RAISE EXCEPTION 'AYVO: a labelling context belongs to a labelling station' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crate_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crates" c WHERE c."id" = NEW."crate_id" AND c."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: a station loads only a crate of its site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "workstation_sessions_context_check" BEFORE INSERT OR UPDATE ON "workstation_sessions"
  FOR EACH ROW EXECUTE FUNCTION workstation_sessions_context_check();

-- =============================================================================================
-- Permissions (owner B4): the operator labels at a station — granted together with retiring the
-- standalone label application (POST /api/admin/label-applications answers 410 from now on).
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

UPDATE "permissions"
   SET "description" = 'Work at a labelling station: apply labels and put bottles into crates (doc 025 A3)'
 WHERE "code" = 'production:label_apply';

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('PRODUCTION_OPERATOR', 'production:label_apply');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
