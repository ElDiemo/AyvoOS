-- Sales commissions PR 1b (doc 068 §3.2, ADR 0046 §2a): the new enum value in its own migration
-- (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_HOTEL_ATTRIBUTION_RECORD';
