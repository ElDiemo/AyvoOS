-- Hotel portal PR 2 (ADR 0045 §4): the idempotency kinds of the Finance → core grant contract, in
-- their own migration (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'PORTAL_GRANT_ISSUE';
ALTER TYPE "OperationKind" ADD VALUE 'PORTAL_GRANT_REPLACE';
