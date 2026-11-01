-- The language of a customer's documents (doc 040 §12): an explicit choice on a customer version,
-- the same for the PDF and the invoice e-mail, never derived from the country. A version without it
-- stays NULL ("not chosen"), which blocks a new invoice and changes nothing in history.
-- Expand only: the running image before this release inserts versions without this column, so NULL
-- stays allowed and the API requires the choice. The database enforces it only in a later release,
-- once no image without the column can return (doc 040 §12a).
ALTER TABLE "finance"."customer_versions" ADD COLUMN "document_language" TEXT;
ALTER TABLE "finance"."customer_versions" ADD CONSTRAINT "customer_versions_document_language_check"
  CHECK ("document_language" IS NULL OR "document_language" IN ('cs', 'en', 'de'));
