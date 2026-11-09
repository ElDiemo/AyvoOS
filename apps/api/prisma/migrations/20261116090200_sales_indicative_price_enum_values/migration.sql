-- Obchod: the idempotency kind of setting the indicative price, in its own migration (PostgreSQL
-- cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_INDICATIVE_PRICE_SET';
