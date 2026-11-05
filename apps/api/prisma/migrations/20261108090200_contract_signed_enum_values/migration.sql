-- The signed original of a contract draft (ADR 0043 §6, doc 045 §7): its enum value in its own
-- migration (PostgreSQL cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'CONTRACT_SIGNED_UPLOAD';
