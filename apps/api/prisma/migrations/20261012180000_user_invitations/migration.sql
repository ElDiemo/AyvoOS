-- User invitations through the identity provider (doc 021 §7b). Additive: two new tables; no
-- existing row changes. The provider's invitation id is stored — never its token or link.

-- CreateEnum
CREATE TYPE "UserInvitationState" AS ENUM ('SENDING', 'PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'FAILED');

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_invitation_id" TEXT,
    "state" "UserInvitationState" NOT NULL DEFAULT 'SENDING',
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_subject" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "failure_code" TEXT,
    "request_id" UUID NOT NULL,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitation_requests" (
    "request_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "actor_id" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),

    CONSTRAINT "user_invitation_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_provider_invitation_id_key" ON "user_invitations"("provider_invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_request_id_key" ON "user_invitations"("request_id");

-- CreateIndex
CREATE INDEX "user_invitations_user_id_created_at_idx" ON "user_invitations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_invitation_requests_invitation_id_idx" ON "user_invitation_requests"("invitation_id");

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitation_requests" ADD CONSTRAINT "user_invitation_requests_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "user_invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Invariants
-- =============================================================================================

ALTER TABLE "user_invitations"
  ADD CONSTRAINT "user_invitations_email_check" CHECK ("email" = lower(btrim("email")) AND "email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "user_invitations_provider_check" CHECK ("provider" IN ('WORKOS', 'TEST')),
  ADD CONSTRAINT "user_invitations_state_check" CHECK (
    ("state" NOT IN ('PENDING', 'ACCEPTED') OR ("provider_invitation_id" IS NOT NULL AND "sent_at" IS NOT NULL))
    AND (("state" = 'ACCEPTED') = ("accepted_at" IS NOT NULL))
    AND (("state" = 'ACCEPTED') = ("accepted_subject" IS NOT NULL))
    AND (("state" = 'REVOKED') = ("revoked_at" IS NOT NULL))
    AND (("state" = 'FAILED') = ("failure_code" IS NOT NULL)));

-- At most one open invitation per e-mail and per user: concurrent duplicate sends fail here.
CREATE UNIQUE INDEX "user_invitations_one_open_per_email" ON "user_invitations" ("email")
  WHERE "state" IN ('SENDING', 'PENDING');
CREATE UNIQUE INDEX "user_invitations_one_open_per_user" ON "user_invitations" ("user_id")
  WHERE "state" IN ('SENDING', 'PENDING');

-- The invitation goes to the prepared user's own (normalized) e-mail.
CREATE FUNCTION user_invitations_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."state" <> 'SENDING' THEN
    RAISE EXCEPTION 'AYVO: an invitation starts as SENDING' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "email" = NEW."email") THEN
    RAISE EXCEPTION 'AYVO: an invitation goes to its user''s e-mail' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_invitations_insert" BEFORE INSERT ON "user_invitations"
  FOR EACH ROW EXECUTE FUNCTION user_invitations_insert();

-- Only forward transitions; identity columns and the provider id (once set) never change.
CREATE FUNCTION user_invitations_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."user_id" <> OLD."user_id" OR NEW."email" <> OLD."email"
     OR NEW."provider" <> OLD."provider" OR NEW."request_id" <> OLD."request_id"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR (OLD."provider_invitation_id" IS NOT NULL
         AND NEW."provider_invitation_id" IS DISTINCT FROM OLD."provider_invitation_id") THEN
    RAISE EXCEPTION 'AYVO: invitation identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND NOT (
       (OLD."state" = 'SENDING' AND NEW."state" IN ('PENDING', 'FAILED', 'REVOKED'))
    OR (OLD."state" = 'PENDING' AND NEW."state" IN ('ACCEPTED', 'EXPIRED', 'REVOKED'))) THEN
    RAISE EXCEPTION 'AYVO: invitation state % cannot become %', OLD."state", NEW."state"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" = OLD."state" AND OLD."state" NOT IN ('SENDING', 'PENDING') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'AYVO: a closed invitation never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_invitations_transition" BEFORE UPDATE ON "user_invitations"
  FOR EACH ROW EXECUTE FUNCTION user_invitations_transition();
CREATE TRIGGER "user_invitations_no_delete" BEFORE DELETE ON "user_invitations"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "user_invitations_no_truncate" BEFORE TRUNCATE ON "user_invitations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "user_invitation_requests"
  ADD CONSTRAINT "user_invitation_requests_kind_check" CHECK ("kind" IN ('SEND', 'RESEND', 'REVOKE')),
  ADD CONSTRAINT "user_invitation_requests_status_check" CHECK (
    "status" IN ('STARTED', 'DONE') AND (("status" = 'DONE') = ("completed_at" IS NOT NULL))),
  ADD CONSTRAINT "user_invitation_requests_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);
CREATE FUNCTION user_invitation_requests_complete_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- While STARTED only the attempt lease may change; completion happens once.
  IF OLD."status" <> 'STARTED'
     OR (to_jsonb(NEW) - ARRAY['status', 'completed_at', 'lease_until'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'completed_at', 'lease_until']) THEN
    RAISE EXCEPTION 'AYVO: an invitation request completes once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_invitation_requests_complete_once" BEFORE UPDATE ON "user_invitation_requests"
  FOR EACH ROW EXECUTE FUNCTION user_invitation_requests_complete_once();
CREATE TRIGGER "user_invitation_requests_no_delete" BEFORE DELETE ON "user_invitation_requests"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "user_invitation_requests_no_truncate" BEFORE TRUNCATE ON "user_invitation_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
