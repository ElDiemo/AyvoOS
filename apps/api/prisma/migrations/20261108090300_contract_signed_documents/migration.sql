-- The signed original of a contract draft (ADR 0043 §6, doc 045 §7): a PDF signed outside AYVO and
-- uploaded by hand, kept as it is in the private FileStorage. No signature is verified. One per
-- draft revision; it locks that revision: never replaced or deleted, the draft never removed and
-- its hotel link never changed after it. A change after signing is a new revision (an amendment
-- proposal); the signed one stays.
CREATE TABLE "contract_signed_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "draft_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "original_filename" TEXT NOT NULL,
    -- The day it was signed, as entered by the uploader (not verified).
    "signed_on" DATE NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    CONSTRAINT "contract_signed_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_signed_documents_file_check" CHECK (
      "storage_key" ~ '^contract-documents/\d{4}/\d{2}/[0-9a-f-]{36}\.pdf$'
      AND "sha256" ~ '^[0-9a-f]{64}$' AND "byte_size" > 0
      AND btrim("original_filename") <> '' AND length("original_filename") <= 200),
    CONSTRAINT "contract_signed_documents_signed_on_check" CHECK ("signed_on" >= DATE '2000-01-01')
);
CREATE UNIQUE INDEX "contract_signed_documents_draft_id_revision_key" ON "contract_signed_documents"("draft_id", "revision");
CREATE UNIQUE INDEX "contract_signed_documents_storage_key_key" ON "contract_signed_documents"("storage_key");
CREATE UNIQUE INDEX "contract_signed_documents_request_id_key" ON "contract_signed_documents"("request_id");
ALTER TABLE "contract_signed_documents"
  ADD CONSTRAINT "contract_signed_documents_draft_id_revision_fkey" FOREIGN KEY ("draft_id", "revision") REFERENCES "contract_draft_revisions"("draft_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contract_signed_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the current revision of a draft that is not removed is signed.
CREATE FUNCTION contract_signed_documents_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "contract_drafts" WHERE "id" = NEW."draft_id"
                   AND "removed_at" IS NULL AND "current_revision" = NEW."revision") THEN
    RAISE EXCEPTION 'AYVO: only the current revision of a draft that is not removed is signed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "contract_signed_documents_insert" BEFORE INSERT ON "contract_signed_documents"
  FOR EACH ROW EXECUTE FUNCTION contract_signed_documents_insert();
CREATE TRIGGER "contract_signed_documents_immutable" BEFORE UPDATE OR DELETE ON "contract_signed_documents"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "contract_signed_documents_no_truncate" BEFORE TRUNCATE ON "contract_signed_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- A draft with a signed original is never removed and its hotel link never changes.
CREATE FUNCTION contract_drafts_signed_lock() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW."removed_at" IS NOT NULL OR NEW."hotel_id" IS DISTINCT FROM OLD."hotel_id")
     AND EXISTS (SELECT 1 FROM "contract_signed_documents" WHERE "draft_id" = OLD."id") THEN
    RAISE EXCEPTION 'AYVO: a signed contract draft is never removed and its hotel never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "contract_drafts_signed_lock" BEFORE UPDATE ON "contract_drafts"
  FOR EACH ROW EXECUTE FUNCTION contract_drafts_signed_lock();
