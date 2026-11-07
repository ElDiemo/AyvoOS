-- R2 "Po mytí" (doc 048 §2): new enum values in their own migration (PostgreSQL cannot use a
-- value added in the same transaction). Additive only.
ALTER TYPE "BottleStatus" ADD VALUE 'READY_FOR_REUSE';
ALTER TYPE "BottleEventType" ADD VALUE 'REUSE_READY';
ALTER TYPE "OperationKind" ADD VALUE 'REUSE_READY_SCAN';
