-- Hotel portal, the operational boundary (v6, #148 comments 6773883145 and 6773928715): a grant's
-- hotel opens either the payer's invoices only (INVOICES) or also the hotel's operations
-- (OPERATIONS: detail, profile, contracts, deliveries), as Finance checked it. Operational access
-- of a payer to a hotel ends at a fence Finance writes before it commits a change of payer, and
-- returns only after that fence's resolution by an explicit restore AND a new check after it.
--
-- Existing grants: every hotel becomes INVOICES (nothing is guessed). Their invoices stay visible;
-- operations come back only with a new check in Finance. The column default fills the existing rows
-- without an UPDATE (grant hotels are never changed, also DB) and is dropped at once, so a new row
-- always names its access.

CREATE TYPE "PortalGrantAccess" AS ENUM ('INVOICES', 'OPERATIONS');

ALTER TABLE "portal_grant_hotels"
  ADD COLUMN "access" "PortalGrantAccess" NOT NULL DEFAULT 'INVOICES',
  ADD COLUMN "checked_revision" INTEGER,
  ADD COLUMN "operations_until" DATE;
ALTER TABLE "portal_grant_hotels" ALTER COLUMN "access" DROP DEFAULT;

-- OPERATIONS always carries the committed revision it was checked in; INVOICES never carries a
-- revision or an end of operations.
ALTER TABLE "portal_grant_hotels" ADD CONSTRAINT "portal_grant_hotels_access_check" CHECK (
  ("access" = 'INVOICES' AND "checked_revision" IS NULL AND "operations_until" IS NULL)
  OR ("access" = 'OPERATIONS' AND "checked_revision" IS NOT NULL AND "checked_revision" >= 1)
);

-- --- Fences and their resolutions (append-only) -------------------------------------------------

CREATE TABLE "portal_operational_fences" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "payer_customer_id" UUID NOT NULL,
    "hotel_id" UUID NOT NULL,
    "ends_on" DATE NOT NULL,
    "terms_revision" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_operational_fences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "portal_operational_fences_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "portal_operational_fences_revision_check" CHECK ("terms_revision" >= 1)
);
CREATE UNIQUE INDEX "portal_operational_fences_request_id_key" ON "portal_operational_fences"("request_id");
CREATE INDEX "portal_operational_fences_payer_customer_id_hotel_id_idx"
  ON "portal_operational_fences"("payer_customer_id", "hotel_id");
ALTER TABLE "portal_operational_fences" ADD CONSTRAINT "portal_operational_fences_hotel_id_fkey"
  FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "portal_operational_fence_resolutions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "fence_id" UUID NOT NULL,
    "restore_revision" INTEGER NOT NULL,
    "restore_request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_operational_fence_resolutions_pkey" PRIMARY KEY ("id")
);
-- At most one resolution per fence.
CREATE UNIQUE INDEX "portal_operational_fence_resolutions_fence_id_key"
  ON "portal_operational_fence_resolutions"("fence_id");
CREATE INDEX "portal_operational_fence_resolutions_restore_request_id_idx"
  ON "portal_operational_fence_resolutions"("restore_request_id");
ALTER TABLE "portal_operational_fence_resolutions" ADD CONSTRAINT "portal_operational_fence_resolutions_fence_id_fkey"
  FOREIGN KEY ("fence_id") REFERENCES "portal_operational_fences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A resolution restores to a revision after the fence's own (v6 §2), also for a direct write.
CREATE FUNCTION portal_fence_resolutions_insert_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  fence_revision INTEGER;
BEGIN
  SELECT "terms_revision" INTO fence_revision FROM "portal_operational_fences" WHERE "id" = NEW."fence_id";
  IF fence_revision IS NULL OR NEW."restore_revision" <= fence_revision THEN
    RAISE EXCEPTION 'AYVO: a fence is resolved only by a later restore revision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "portal_fence_resolutions_insert_rules" BEFORE INSERT ON "portal_operational_fence_resolutions"
  FOR EACH ROW EXECUTE FUNCTION portal_fence_resolutions_insert_rules();

CREATE FUNCTION portal_fences_no_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'AYVO: operational fences and their resolutions are history; never changed or deleted'
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER "portal_operational_fences_no_change" BEFORE UPDATE OR DELETE ON "portal_operational_fences"
  FOR EACH ROW EXECUTE FUNCTION portal_fences_no_change();
CREATE TRIGGER "portal_operational_fence_resolutions_no_change" BEFORE UPDATE OR DELETE ON "portal_operational_fence_resolutions"
  FOR EACH ROW EXECUTE FUNCTION portal_fences_no_change();
