-- Weights and dimensions (doc 025 §10, PR W1) — enum value only (PostgreSQL cannot use a new enum
-- value in the transaction that adds it).

ALTER TYPE "OperationKind" ADD VALUE 'MEASUREMENT_RECORD';
