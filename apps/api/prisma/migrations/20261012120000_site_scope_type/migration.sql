-- Multi-site foundation (doc 022), step 1 of 2: the new enum value must be committed before the
-- next migration can use it (PostgreSQL), so it lives in its own migration.
ALTER TYPE "ScopeType" ADD VALUE 'SITE';
