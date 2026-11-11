-- Obchod: two optional profile fields of a prospect (owner 2026-11-09 night, recommended variant
-- of doc 060 §A; table design subject to the owner's PR review). Free text, no invented list:
-- what the hotel uses today, and its main objection. NULL = not known (never ''). Changes go
-- through the ordinary profile edit (revision + PROSPECT_UPDATED event with before → after).
ALTER TABLE "sales_prospects"
  ADD COLUMN "current_amenities" TEXT,
  ADD COLUMN "main_objection" TEXT,
  ADD CONSTRAINT "sales_prospects_amenities_objection_check" CHECK (
    ("current_amenities" IS NULL OR (btrim("current_amenities") <> '' AND length("current_amenities") <= 500))
    AND ("main_objection" IS NULL OR (btrim("main_objection") <> '' AND length("main_objection") <= 500))
  );
