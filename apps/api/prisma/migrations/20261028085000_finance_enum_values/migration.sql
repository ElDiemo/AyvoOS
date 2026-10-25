-- Finance (doc 039, N1): operation kinds for the idempotent receive / takeover requests. A
-- separate migration — a new enum value cannot be used in the transaction that adds it.

ALTER TYPE "OperationKind" ADD VALUE 'FINANCE_DOCUMENT_RECEIVE';
ALTER TYPE "OperationKind" ADD VALUE 'FINANCE_DOCUMENT_TAKEOVER';
