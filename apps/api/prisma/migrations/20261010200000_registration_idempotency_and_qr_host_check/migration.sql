-- Milestone 1 hardening (doc 016). Forward-only.

-- 1. Idempotent bottle registration: a client-generated request id per registration. Rows created
--    before this migration keep NULL (a unique index ignores NULLs); the API requires the id for
--    every new registration. Batch rows stay immutable (existing trigger).

-- AlterTable
ALTER TABLE "bottle_creation_batches" ADD COLUMN     "client_request_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "bottle_creation_batches_client_request_id_key" ON "bottle_creation_batches"("client_request_id");

-- 2. QR environment invariant by parsed HOST instead of a substring (ADR 0014), matching the
--    application policy (apps/api/src/common/qr-policy.ts): userinfo ("user@"), ports, case and
--    a trailing dot cannot hide the production QR host; subdomains of it count as production.

-- Host of an absolute URL: lower-cased, without userinfo, port or trailing dot (NULL if none).
CREATE FUNCTION ayvo_url_host(url text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT rtrim(lower(substring(url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)')), '.') $$;

ALTER TABLE "label_print_jobs" DROP CONSTRAINT "label_print_jobs_qr_environment_check";
ALTER TABLE "label_print_jobs"
  ADD CONSTRAINT "label_print_jobs_qr_environment_check"
    CHECK (CASE WHEN "app_environment" = 'production'
                THEN "public_base_url" = 'https://qr.ayvo.co'
                ELSE coalesce(ayvo_url_host("public_base_url"), '') <> 'qr.ayvo.co'
                     AND coalesce(ayvo_url_host("public_base_url"), '') NOT LIKE '%.qr.ayvo.co' END);
