-- Order states and carrier tracking (doc 031): new enum values, in their own migration (PostgreSQL
-- cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OrderStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "CrateCycleStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "CrateEventType" ADD VALUE 'DELIVERED';
ALTER TYPE "OrderEventType" ADD VALUE 'PARCEL_PICKED_UP';
ALTER TYPE "OrderEventType" ADD VALUE 'PARCEL_DELIVERED';
ALTER TYPE "OrderEventType" ADD VALUE 'DELIVERED';
ALTER TYPE "OperationKind" ADD VALUE 'SHIPMENT_TRACKING_SYNC';
