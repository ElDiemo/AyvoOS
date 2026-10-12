-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('WAREHOUSE', 'HOTEL_ORGANIZATION', 'HOTEL_SITE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "deactivated_at" TIMESTAMPTZ(3),
    "deactivated_by" UUID,
    "deactivation_reason" TEXT,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_link" TEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "warehouse_scoped" BOOLEAN NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_code" TEXT NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_code","permission_code")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role_code" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,
    "grant_reason" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_scopes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "type" "ScopeType" NOT NULL,
    "location_id" UUID,
    "scope_ref" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,

    CONSTRAINT "user_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token_sha256" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "provider_session_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_login_states" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "state_sha256" CHAR(64) NOT NULL,
    "binding_sha256" CHAR(64) NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "next_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_login_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_bootstrap" (
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_bootstrap_pkey" PRIMARY KEY ("singleton")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "target_user_id" UUID,
    "reason" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_scopes_user_id_idx" ON "user_scopes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_sha256_key" ON "user_sessions"("token_sha256");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_login_states_state_sha256_key" ON "auth_login_states"("state_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "identity_bootstrap_user_id_key" ON "identity_bootstrap"("user_id");

-- CreateIndex
CREATE INDEX "audit_events_target_user_id_occurred_at_idx" ON "audit_events"("target_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_by_fkey" FOREIGN KEY ("deactivated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_bootstrap" ADD CONSTRAINT "identity_bootstrap_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Hand-written invariants (Prisma cannot express them) — identity and access (ADR 0022, doc 021)
-- =============================================================================================

-- --- Users --------------------------------------------------------------------------------------

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_check" CHECK ("email" = lower("email") AND "email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "users_display_name_check" CHECK (length(btrim("display_name")) > 0),
  ADD CONSTRAINT "users_deactivation_check" CHECK (
    ("status" = 'DEACTIVATED') = ("deactivated_at" IS NOT NULL)
    AND ("deactivated_at" IS NULL) = ("deactivation_reason" IS NULL));

CREATE FUNCTION users_identity_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."email" <> OLD."email" OR NEW."created_at" <> OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
    RAISE EXCEPTION 'AYVO: user identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "users_identity_immutable" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_identity_immutable();
CREATE TRIGGER "users_no_delete" BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "users_no_truncate" BEFORE TRUNCATE ON "users"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- External identities ---------------------------------------------------------------------

ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_provider_check" CHECK ("provider" IN ('WORKOS', 'TEST')),
  ADD CONSTRAINT "user_identities_subject_check" CHECK (length("subject") BETWEEN 1 AND 255);
CREATE UNIQUE INDEX "user_identities_active_subject" ON "user_identities" ("provider", "subject")
  WHERE "unlinked_at" IS NULL;
CREATE UNIQUE INDEX "user_identities_active_per_user" ON "user_identities" ("user_id", "provider")
  WHERE "unlinked_at" IS NULL;

CREATE FUNCTION user_identities_unlink_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."unlinked_at" IS NOT NULL
     OR (to_jsonb(NEW) - 'unlinked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'unlinked_at') THEN
    RAISE EXCEPTION 'AYVO: an identity link can only be closed once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_identities_unlink_once" BEFORE UPDATE ON "user_identities"
  FOR EACH ROW EXECUTE FUNCTION user_identities_unlink_once();
CREATE TRIGGER "user_identities_no_delete" BEFORE DELETE ON "user_identities"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "user_identities_no_truncate" BEFORE TRUNCATE ON "user_identities"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Role and permission catalogue (seeded; changes only by migration) -------------------------

CREATE TRIGGER "roles_immutable" BEFORE UPDATE OR DELETE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "permissions_immutable" BEFORE UPDATE OR DELETE ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "role_permissions_immutable" BEFORE UPDATE OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();

INSERT INTO "roles" ("code", "name", "description") VALUES
  ('ADMIN', 'Administrátor', 'Users, roles and system configuration; not a routine operational approver'),
  ('WAREHOUSE_OPERATOR', 'Skladník', 'Receives goods and reads stock'),
  ('WAREHOUSE_SUPERVISOR', 'Vedoucí skladu', 'Receipts, corrections, item planning settings, suppliers'),
  ('PRODUCTION_OPERATOR', 'Operátor výroby', 'Production work: reads production data, prints labels'),
  ('PRODUCTION_SUPERVISOR', 'Vedoucí výroby', 'Creates bottles, manages label templates, applies labels'),
  ('SALES', 'Obchod', 'Sales (module not implemented yet: no permissions)'),
  ('FINANCE', 'Finance', 'Finance (module not implemented yet: no permissions)'),
  ('HOTEL_USER', 'Uživatel hotelu', 'Hotel portal (separate environment, not implemented: no internal permissions)');

INSERT INTO "permissions" ("code", "description", "warehouse_scoped") VALUES
  ('identity:users_read', 'Read users, roles, scopes and the security audit', false),
  ('identity:users_manage', 'Create users, grant/revoke roles and scopes, deactivate/reactivate', false),
  ('inventory:read', 'Read stock, lots, movements, items, suppliers and goods receipts', true),
  ('inventory:receive', 'Record goods receipts and supplier documents', true),
  ('inventory:correct', 'Record compensating receipt corrections', true),
  ('inventory:items_manage', 'Change item planning settings', true),
  ('procurement:suppliers_manage', 'Create and archive suppliers', true),
  ('production:read', 'Read bottles, series, print jobs, label templates and label applications', false),
  ('production:bottles_create', 'Register bottle identities and create print jobs', false),
  ('production:labels_print', 'Generate label print PDFs', false),
  ('production:templates_manage', 'Create label templates and versions, archive and restore', false),
  ('production:label_apply', 'Standalone label application (supervisor-only until the production scan, doc 020)', true);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'identity:users_read'),
  ('ADMIN', 'identity:users_manage'),
  ('WAREHOUSE_OPERATOR', 'inventory:read'),
  ('WAREHOUSE_OPERATOR', 'inventory:receive'),
  ('WAREHOUSE_SUPERVISOR', 'inventory:read'),
  ('WAREHOUSE_SUPERVISOR', 'inventory:receive'),
  ('WAREHOUSE_SUPERVISOR', 'inventory:correct'),
  ('WAREHOUSE_SUPERVISOR', 'inventory:items_manage'),
  ('WAREHOUSE_SUPERVISOR', 'procurement:suppliers_manage'),
  ('PRODUCTION_OPERATOR', 'production:read'),
  ('PRODUCTION_OPERATOR', 'production:labels_print'),
  ('PRODUCTION_OPERATOR', 'inventory:read'),
  ('PRODUCTION_SUPERVISOR', 'production:read'),
  ('PRODUCTION_SUPERVISOR', 'production:labels_print'),
  ('PRODUCTION_SUPERVISOR', 'production:bottles_create'),
  ('PRODUCTION_SUPERVISOR', 'production:templates_manage'),
  ('PRODUCTION_SUPERVISOR', 'production:label_apply'),
  ('PRODUCTION_SUPERVISOR', 'inventory:read');

-- --- Role grants and scopes: open → closed once, never deleted -------------------------------

ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_grant_reason_check" CHECK (length(btrim("grant_reason")) > 0),
  ADD CONSTRAINT "user_roles_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));
CREATE UNIQUE INDEX "user_roles_one_open_grant" ON "user_roles" ("user_id", "role_code")
  WHERE "revoked_at" IS NULL;

CREATE FUNCTION user_roles_revoke_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason']) THEN
    RAISE EXCEPTION 'AYVO: a role grant can only be revoked once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_roles_revoke_once" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION user_roles_revoke_once();
CREATE TRIGGER "user_roles_no_delete" BEFORE DELETE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "user_roles_no_truncate" BEFORE TRUNCATE ON "user_roles"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "user_scopes"
  ADD CONSTRAINT "user_scopes_target_check" CHECK (
    ("type" = 'WAREHOUSE') = ("location_id" IS NOT NULL)
    AND ("type" = 'WAREHOUSE') = ("scope_ref" IS NULL));
CREATE UNIQUE INDEX "user_scopes_one_open_warehouse" ON "user_scopes" ("user_id", "location_id")
  WHERE "revoked_at" IS NULL AND "type" = 'WAREHOUSE';
CREATE UNIQUE INDEX "user_scopes_one_open_hotel" ON "user_scopes" ("user_id", "type", "scope_ref")
  WHERE "revoked_at" IS NULL AND "type" <> 'WAREHOUSE';

CREATE FUNCTION user_scopes_revoke_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by']) THEN
    RAISE EXCEPTION 'AYVO: a scope can only be revoked once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_scopes_revoke_once" BEFORE UPDATE ON "user_scopes"
  FOR EACH ROW EXECUTE FUNCTION user_scopes_revoke_once();
CREATE TRIGGER "user_scopes_no_delete" BEFORE DELETE ON "user_scopes"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "user_scopes_no_truncate" BEFORE TRUNCATE ON "user_scopes"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Sessions: only activity and one revocation may change ------------------------------------

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_token_sha256_check" CHECK ("token_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "user_sessions_expiry_check" CHECK (
    "idle_expires_at" <= "absolute_expires_at" AND "absolute_expires_at" > "created_at"),
  ADD CONSTRAINT "user_sessions_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));

CREATE FUNCTION user_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoke_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoke_reason'])
     OR (OLD."revoked_at" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'AYVO: a session can only record activity and be revoked once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "user_sessions_guard" BEFORE UPDATE ON "user_sessions"
  FOR EACH ROW EXECUTE FUNCTION user_sessions_guard();
CREATE TRIGGER "user_sessions_no_delete" BEFORE DELETE ON "user_sessions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();

-- --- Login states: one use --------------------------------------------------------------------

ALTER TABLE "auth_login_states"
  ADD CONSTRAINT "auth_login_states_hash_check" CHECK (
    "state_sha256" ~ '^[0-9a-f]{64}$' AND "binding_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "auth_login_states_next_path_check" CHECK (
    "next_path" ~ '^/' AND "next_path" !~ '^//' AND position('\' in "next_path") = 0);

-- --- Bootstrap of the first administrator: one row, ever --------------------------------------

ALTER TABLE "identity_bootstrap"
  ADD CONSTRAINT "identity_bootstrap_singleton_check" CHECK ("singleton");
CREATE TRIGGER "identity_bootstrap_immutable" BEFORE UPDATE OR DELETE ON "identity_bootstrap"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "identity_bootstrap_no_truncate" BEFORE TRUNCATE ON "identity_bootstrap"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Audit: append-only -----------------------------------------------------------------------

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_type_check" CHECK ("type" ~ '^[A-Z][A-Z_]{2,63}$');
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
