-- Hotel portal PR 1 (ADR 0045 §2 on `0d500f6`, owner 2026-11-07, #127 comment 6711432652): every
-- account, role, session, one-time token and pre-session challenge belongs to one audience —
-- STAFF (the internal OS) or PORTAL (the hotel portal). The database refuses any mix, so an
-- account can never hold an internal and a hotel role, and no session, link or sign-in step of one
-- audience is ever valid for the other. Existing rows are STAFF (the column default; no row is
-- rewritten, no history touched). HOTEL_USER (a planned, unassignable system role) is the one
-- PORTAL role.
--
-- Atomic: Prisma runs this file as one transaction. The data check below runs FIRST, before any
-- DDL, so a refused migration leaves nothing behind (verified by test/account-audience-migration).

-- --- Preflight: HOTEL_USER was never assignable (doc 021 §4c) ---------------------------------

-- An open grant of it would contradict the new rule: stop instead of rewriting it (the owner
-- decides).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_roles" WHERE "role_code" = 'HOTEL_USER' AND "revoked_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: an open HOTEL_USER grant exists; resolve it before the account audience migration';
  END IF;
END
$$;

CREATE TYPE "AccountAudience" AS ENUM ('STAFF', 'PORTAL');

ALTER TABLE "users" ADD COLUMN "audience" "AccountAudience" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "roles" ADD COLUMN "audience" "AccountAudience" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "user_sessions" ADD COLUMN "audience" "AccountAudience" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "native_auth_tokens" ADD COLUMN "audience" "AccountAudience" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "native_auth_challenges" ADD COLUMN "audience" "AccountAudience" NOT NULL DEFAULT 'STAFF';

-- --- The catalogue: HOTEL_USER is the PORTAL role ---------------------------------------------

-- roles_guard lets a system role change only under the catalogue flag; this is the one change of
-- an audience ever made, before the rule below exists.
SELECT set_config('ayvo.catalogue_migration', 'on', false);
UPDATE "roles" SET "audience" = 'PORTAL' WHERE "code" = 'HOTEL_USER';
SELECT set_config('ayvo.catalogue_migration', 'off', false);

-- --- An audience never changes ----------------------------------------------------------------

CREATE FUNCTION users_audience_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."audience" <> OLD."audience" THEN
    RAISE EXCEPTION 'AYVO: an account''s audience never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "users_audience_immutable" BEFORE UPDATE OF "audience" ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_audience_immutable();

-- A role's audience is fixed by its code: HOTEL_USER is PORTAL, every other role (system or
-- custom) is STAFF; it never changes. There is deliberately NO exemption for the catalogue flag:
-- any session can set `ayvo.catalogue_migration`, the runtime role included, so a flag cannot be
-- what keeps an internal role from becoming a hotel one. A future PORTAL role needs its own
-- migration that replaces this function.
CREATE FUNCTION roles_audience_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."audience" IS DISTINCT FROM
     (CASE WHEN NEW."code" = 'HOTEL_USER' THEN 'PORTAL' ELSE 'STAFF' END)::"AccountAudience" THEN
    RAISE EXCEPTION 'AYVO: only HOTEL_USER is a PORTAL role; every other role is STAFF'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."audience" <> OLD."audience" THEN
    RAISE EXCEPTION 'AYVO: a role''s audience never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "roles_audience_rules" BEFORE INSERT OR UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION roles_audience_rules();

-- --- A role only for an account of its audience (the user row locked first) -------------------

-- A plain CHECK cannot see the user or the role. The trigger locks the user row before it reads
-- anything (the fixed order: user → role grants), so concurrent grants to one account serialize.
CREATE FUNCTION user_roles_audience() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  account "AccountAudience";
  wanted "AccountAudience";
BEGIN
  SELECT "audience" INTO account FROM "users" WHERE "id" = NEW."user_id" FOR UPDATE;
  SELECT "audience" INTO wanted FROM "roles" WHERE "code" = NEW."role_code";
  IF account IS DISTINCT FROM wanted THEN
    RAISE EXCEPTION 'AYVO: a % role is never granted to a % account', wanted, account
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_roles_audience" BEFORE INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION user_roles_audience();

-- --- Sessions, one-time tokens and pre-session challenges carry their user's audience ---------

CREATE FUNCTION ayvo_audience_of_user() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."audience" <> OLD."audience" OR NEW."user_id" <> OLD."user_id" THEN
      RAISE EXCEPTION 'AYVO: the audience of % never changes', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."audience" IS DISTINCT FROM (SELECT "audience" FROM "users" WHERE "id" = NEW."user_id") THEN
    RAISE EXCEPTION 'AYVO: % belongs to its user''s audience', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_sessions_audience" BEFORE INSERT OR UPDATE ON "user_sessions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_audience_of_user();
CREATE TRIGGER "native_auth_tokens_audience" BEFORE INSERT OR UPDATE ON "native_auth_tokens"
  FOR EACH ROW EXECUTE FUNCTION ayvo_audience_of_user();
CREATE TRIGGER "native_auth_challenges_audience" BEFORE INSERT OR UPDATE ON "native_auth_challenges"
  FOR EACH ROW EXECUTE FUNCTION ayvo_audience_of_user();
