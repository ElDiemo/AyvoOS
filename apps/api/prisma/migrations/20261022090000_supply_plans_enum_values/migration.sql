-- Hotel supply plans and automatic orders (doc 032): new enum values in their own migration
-- (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SUPPLY_PLAN_SAVE';
ALTER TYPE "OperationKind" ADD VALUE 'SUPPLY_PLAN_ACTIVATE';
ALTER TYPE "OperationKind" ADD VALUE 'SUPPLY_PLAN_PAUSE';
ALTER TYPE "OperationKind" ADD VALUE 'SUPPLY_PLAN_ORDER';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_RESCHEDULE';
ALTER TYPE "OperationKind" ADD VALUE 'HOTEL_UPDATE';
ALTER TYPE "OrderEventType" ADD VALUE 'RESCHEDULED';
