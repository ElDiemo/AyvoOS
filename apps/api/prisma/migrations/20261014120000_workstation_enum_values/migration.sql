-- Workstations and work sessions (doc 026, A2) — enum values only. PostgreSQL cannot use a new
-- enum value in the transaction that adds it (doc 020 §13).

ALTER TYPE "OperationKind" ADD VALUE 'WORKSTATION_CREATE';
ALTER TYPE "OperationKind" ADD VALUE 'WORKSTATION_DEACTIVATE';
ALTER TYPE "OperationKind" ADD VALUE 'WORKSTATION_REACTIVATE';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_SESSION_OPEN';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_SESSION_RELEASE';
ALTER TYPE "OperationKind" ADD VALUE 'STATION_SESSION_TAKEOVER';
ALTER TYPE "QrIdentityKind" ADD VALUE 'WORKSTATION';
