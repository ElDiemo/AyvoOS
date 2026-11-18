-- R3-b (doc 048 §3.0, §8.2 step 2): a washed bottle placed into a crate is a REUSE member. The
-- enum value in its own migration (PostgreSQL: a new value is usable only after its commit).
ALTER TYPE "CrateAssignmentSource" ADD VALUE 'REUSE';
