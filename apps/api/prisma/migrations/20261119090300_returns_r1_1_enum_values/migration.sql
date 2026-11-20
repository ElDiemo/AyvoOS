-- Return intake R1.1 (doc 047 §6.3, owner 2026-11-18): the receipt's one line of individually
-- scanned bottles. The new value in its own migration (PostgreSQL cannot use a value added in the
-- same transaction). Additive only.
ALTER TYPE "ReturnLineKind" ADD VALUE 'BOTTLES';
