-- Obchod — CSV import of prospects (doc 034 §13): the operation kind in its own migration
-- (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_IMPORT';
