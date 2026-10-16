-- Labelling into crates (doc 025 A3) — enum values only. PostgreSQL cannot use a new enum value
-- in the transaction that adds it (doc 020 §13).

ALTER TYPE "BottleEventType" ADD VALUE 'ASSIGNED_TO_CRATE';
ALTER TYPE "CrateEventType" ADD VALUE 'CYCLE_OPENED';
ALTER TYPE "CrateEventType" ADD VALUE 'READY_TO_FILL';
ALTER TYPE "OperationKind" ADD VALUE 'PRODUCT_LABEL_APPROVE';
ALTER TYPE "OperationKind" ADD VALUE 'PRODUCT_LABEL_REVOKE';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_LABELING_CONTEXT';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_CRATE_LOAD';
ALTER TYPE "OperationKind" ADD VALUE 'LABEL_SCAN';
ALTER TYPE "WorkstationSessionEventType" ADD VALUE 'CONTEXT_CHANGED';
ALTER TYPE "WorkstationSessionEventType" ADD VALUE 'CRATE_LOADED';
