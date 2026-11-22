-- Hotel portal, the operational boundary A2 (review 5858166766): the idempotency kind that settles a
-- fence request Finance abandons — a later arrival of that request then writes nothing. In its own
-- migration (a value added in a transaction cannot be used in it). Additive only.
ALTER TYPE "OperationKind" ADD VALUE 'PORTAL_FENCE_SETTLE';
