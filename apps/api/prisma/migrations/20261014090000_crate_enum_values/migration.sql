-- Physical crates and their QR labels (doc 020 §3.4, doc 025 PR A1) — enum values only.
-- PostgreSQL cannot use a new enum value in the transaction that adds it (doc 020 §13).

-- Idempotent crate operations (OperationRequestsService).
ALTER TYPE "OperationKind" ADD VALUE 'CRATE_REGISTER';
ALTER TYPE "OperationKind" ADD VALUE 'CRATE_LABEL_PRINT';
