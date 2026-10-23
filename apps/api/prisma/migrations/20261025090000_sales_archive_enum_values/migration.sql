-- Obchod — archiving a prospect (doc 034 §3a): the operation kind in its own migration (PostgreSQL
-- cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_PROSPECT_ARCHIVE';
