-- Carrier settings per site (doc 029 §9): operation kinds, in their own migration (PostgreSQL
-- cannot use a value added in the same transaction). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_SETTINGS_UPDATE';
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_CONNECTION_VERIFY';
-- Carrier connections managed in the administration (ADR 0027).
ALTER TYPE "OperationKind" ADD VALUE 'CARRIER_CREDENTIALS_REPLACE';
