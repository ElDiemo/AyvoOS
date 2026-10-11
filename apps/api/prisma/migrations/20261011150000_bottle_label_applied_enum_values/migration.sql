-- Milestone 2A (doc 018), part 1 of 2: new lifecycle values for physical label application.
-- Kept in its own migration: PostgreSQL cannot use an enum value in the transaction that adds it,
-- and part 2 references these values in indexes, constraints and triggers.

-- AlterEnum
ALTER TYPE "BottleEventType" ADD VALUE 'LABEL_APPLIED';

-- AlterEnum
ALTER TYPE "BottleStatus" ADD VALUE 'LABELED_EMPTY';
