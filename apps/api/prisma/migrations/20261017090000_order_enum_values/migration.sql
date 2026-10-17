-- Hotels, manual orders and picking (doc 028) — enum values only. PostgreSQL cannot use a new enum
-- value in the transaction that adds it (doc 020 §13).

ALTER TYPE "CrateCycleStatus" ADD VALUE 'ALLOCATED';
ALTER TYPE "CrateEventType" ADD VALUE 'ALLOCATED_TO_ORDER';
ALTER TYPE "CrateEventType" ADD VALUE 'RELEASED_FROM_ORDER';
ALTER TYPE "OperationKind" ADD VALUE 'HOTEL_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_CRATE_ADD';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_CRATE_REMOVE';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_COMPLETE';
ALTER TYPE "OperationKind" ADD VALUE 'ORDER_CANCEL';
