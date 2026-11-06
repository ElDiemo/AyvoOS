-- A crate takes a new member only in LABELED_EMPTY or FILLED (R1 follow-up, PR #129 comment
-- 6695354613): a RETURNED, RETIRED or DISPOSED bottle in a crate would make it unfillable. The
-- check runs at commit, so labelling, REPLACEMENT and REPACKED keep the order of their writes
-- (the labelling scan sets LABELED_EMPTY in the same transaction). Only new memberships are
-- checked; existing rows are never rewritten (no automatic correction of history).

CREATE FUNCTION crate_assignments_member_placeable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
              WHERE a."id" = NEW."id" AND a."released_at" IS NULL
                AND b."status" NOT IN ('LABELED_EMPTY', 'FILLED')) THEN
    RAISE EXCEPTION 'AYVO: a crate takes a new member only in LABELED_EMPTY or FILLED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "crate_assignments_member_placeable" AFTER INSERT ON "crate_assignments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crate_assignments_member_placeable();
