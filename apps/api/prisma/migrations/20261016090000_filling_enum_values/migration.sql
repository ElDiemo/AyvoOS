-- Filling, Hotovo and supervised crate corrections (doc 025 A4) — enum values only. PostgreSQL
-- cannot use a new enum value in the transaction that adds it (doc 020 §13).

ALTER TYPE "BottleStatus" ADD VALUE 'FILLED';
ALTER TYPE "BottleEventType" ADD VALUE 'FILLED';
ALTER TYPE "BottleEventType" ADD VALUE 'REMOVED_FROM_CRATE';
ALTER TYPE "ComponentType" ADD VALUE 'PUMP';
ALTER TYPE "InventoryMovementType" ADD VALUE 'FILL';
ALTER TYPE "CrateEventType" ADD VALUE 'FILLING_STARTED';
ALTER TYPE "CrateEventType" ADD VALUE 'CRATE_FILLED';
ALTER TYPE "CrateEventType" ADD VALUE 'RETURNED_TO_FILLING';
ALTER TYPE "CrateEventType" ADD VALUE 'CYCLE_ABORTED';
ALTER TYPE "CrateEventType" ADD VALUE 'MEMBER_REMOVED';
ALTER TYPE "CrateEventType" ADD VALUE 'MEMBER_ADDED';
ALTER TYPE "CrateAssignmentSource" ADD VALUE 'REPACKED';
ALTER TYPE "CrateAssignmentSource" ADD VALUE 'REPLACEMENT';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_LIQUID_LOT';
ALTER TYPE "OperationKind" ADD VALUE 'FILL_SCAN';
ALTER TYPE "OperationKind" ADD VALUE 'CRATE_FINISH';
ALTER TYPE "OperationKind" ADD VALUE 'CYCLE_MEMBER_REMOVE';
ALTER TYPE "OperationKind" ADD VALUE 'CYCLE_MEMBER_ADD';
ALTER TYPE "OperationKind" ADD VALUE 'CYCLE_REOPEN';
ALTER TYPE "OperationKind" ADD VALUE 'CYCLE_ABORT';
ALTER TYPE "WorkstationSessionEventType" ADD VALUE 'LIQUID_LOT_CHANGED';
