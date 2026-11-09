-- Obchod: the indicative price per room and month for the salesperson's calculator (owner
-- 2026-11-09 night, the recommended variant of doc 060 §D; subject to the owner's PR review).
-- Entered by the sales manager, never a default; append-only versions, the newest per currency is
-- current. Never a price list of Finance, an offer or an invoice: Obchod only shows it, labelled
-- "orientační". The note says what the amount includes (e.g. VAT), so nothing is assumed.
CREATE TABLE "sales_indicative_prices" (
  "id"         UUID NOT NULL DEFAULT uuidv7(),
  "currency"   CHAR(3) NOT NULL,
  "amount"     NUMERIC(12, 2) NOT NULL,
  "note"       TEXT NOT NULL,
  "set_by"     UUID NOT NULL,
  "set_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "request_id" UUID NOT NULL,
  CONSTRAINT "sales_indicative_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_indicative_prices_request_key" UNIQUE ("request_id"),
  CONSTRAINT "sales_indicative_prices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "sales_indicative_prices_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "sales_indicative_prices_note_check" CHECK (btrim("note") <> '' AND length("note") <= 300),
  CONSTRAINT "sales_indicative_prices_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX "sales_indicative_prices_currency_set_at_idx" ON "sales_indicative_prices" ("currency", "set_at" DESC, "id" DESC);
CREATE TRIGGER "sales_indicative_prices_append_only" BEFORE UPDATE OR DELETE ON "sales_indicative_prices"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "sales_indicative_prices_no_truncate" BEFORE TRUNCATE ON "sales_indicative_prices"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
