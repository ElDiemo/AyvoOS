-- Product catalogue and recipes v0.1 (doc 023) — enum values only. PostgreSQL cannot use a new
-- enum value in the transaction that adds it, so they come in their own migration (doc 020 §13).

-- Filling (2B): recipe BOMs may hold liquid and pump lines now; nothing consumes them yet.
ALTER TYPE "ConsumptionStage" ADD VALUE 'FILL';

-- Idempotent catalogue operations (OperationRequestsService).
ALTER TYPE "OperationKind" ADD VALUE 'CATALOG_COMPONENT_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'CRATE_TYPE_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'PRODUCT_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'PRODUCT_RENAME';
ALTER TYPE "OperationKind" ADD VALUE 'PRODUCT_ARCHIVE';
ALTER TYPE "OperationKind" ADD VALUE 'RECIPE_DRAFT_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'RECIPE_DRAFT_UPDATE';
ALTER TYPE "OperationKind" ADD VALUE 'RECIPE_ACTIVATE';
ALTER TYPE "OperationKind" ADD VALUE 'RECIPE_ARCHIVE';
