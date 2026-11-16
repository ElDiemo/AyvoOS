-- Hotel portal, the operational boundary (v6, #148 comments 6773883145 and 6773928715): the
-- idempotency kinds of the Finance → core fence contract, in their own migration (PostgreSQL cannot
-- use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'PORTAL_FENCE_WRITE';
ALTER TYPE "OperationKind" ADD VALUE 'PORTAL_FENCE_RESOLVE';
