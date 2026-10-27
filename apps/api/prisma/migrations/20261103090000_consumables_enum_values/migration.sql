-- Consumables issued to consumption by hand (owner 2026-10-27, doc 018 §5a). Enum values only:
-- PostgreSQL uses a new enum value safely only after this migration's transaction commits; the
-- next migration (20261103090100_consumption_issues) uses them.
ALTER TYPE "InventoryItemKind" ADD VALUE 'CONSUMABLE';
ALTER TYPE "InventoryMovementType" ADD VALUE 'CONSUMPTION_ISSUE';
ALTER TYPE "OperationKind" ADD VALUE 'STOCK_ISSUE';
