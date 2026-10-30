-- The language of a customer's documents (doc 040 §12): an explicit choice on a customer version,
-- the same for the PDF and the invoice e-mail, never derived from the country. Versions recorded
-- before this migration stay NULL ("not chosen"), which blocks a new invoice and changes nothing in
-- history. A new version must choose: NULL is refused for every row inserted from now on.
ALTER TABLE "finance"."customer_versions" ADD COLUMN "document_language" TEXT;
ALTER TABLE "finance"."customer_versions" ADD CONSTRAINT "customer_versions_document_language_check"
  CHECK ("document_language" IS NULL OR "document_language" IN ('cs', 'en', 'de'));

CREATE FUNCTION "finance"."customer_version_language_required"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."document_language" IS NULL THEN
    RAISE EXCEPTION 'a new customer version must choose its document language'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "customer_versions_language_required" BEFORE INSERT ON "finance"."customer_versions"
  FOR EACH ROW EXECUTE FUNCTION "finance"."customer_version_language_required"();
