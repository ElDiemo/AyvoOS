-- Contract drafts (ADR 0043, doc 045): new enum values in their own migration (PostgreSQL cannot
-- use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_DRAFT_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_DRAFT_REVISE';
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_DRAFT_REMOVE';
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_DRAFT_RESTORE';
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_DRAFT_HOTEL';
