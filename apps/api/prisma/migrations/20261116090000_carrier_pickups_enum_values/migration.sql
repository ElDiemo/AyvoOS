-- Pickup orders at the carrier ("svoz", doc 029 §11, owner 2026-11-14): new enum values in their
-- own migration (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_PICKUP_ORDER';
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_PICKUP_RESOLVE';
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_PICKUP_CANCEL';
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_PICKUP_CANCEL_RESOLVE';
