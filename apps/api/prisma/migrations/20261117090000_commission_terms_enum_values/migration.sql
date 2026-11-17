-- Sales commissions PR 1a (doc 068 §3.1, ADR 0046 §2a): the new enum value in its own migration
-- (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_COMMISSION_TERMS_RECORD';
