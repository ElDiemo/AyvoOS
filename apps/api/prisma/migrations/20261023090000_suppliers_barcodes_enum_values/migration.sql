-- Supplier details and item barcodes (doc 033): new enum values in their own migration
-- (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'SUPPLIER_UPDATE';
ALTER TYPE "OperationKind" ADD VALUE 'ITEM_BARCODE_ASSIGN';
ALTER TYPE "OperationKind" ADD VALUE 'ITEM_BARCODE_RETIRE';
