-- Obchod — hotel acquisition (doc 034): new enum values in their own migration (PostgreSQL cannot
-- use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SALES_PROSPECT_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_PROSPECT_UPDATE';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_STAGE_CHANGE';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_OWNER_CHANGE';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_CONTACT_SAVE';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_ACTIVITY_RECORD';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_ACTIVITY_CORRECT';
ALTER TYPE "OperationKind" ADD VALUE 'SALES_TASK_SAVE';
