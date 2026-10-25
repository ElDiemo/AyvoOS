# ADR 0041: The running core connects as its own non-superuser DB role

- **Status:** Proposed — for review. Requested by the owner on 2026-10-25
  (`FINANCE-BOUNDARY-DECISION-20261025.md`: "dočasně společný web + databázová oprava") as a
  separate PR; verified on a throw-away database and in CI only. Not deployed anywhere.
- **Date:** 2026-10-25
- **Context:** API and migrations connect as the account the official PostgreSQL image creates
  (`POSTGRES_USER`), a **superuser**. A superuser ignores `GRANT`/`REVOKE`, can switch triggers
  off (`session_replication_role`, `ALTER TABLE … DISABLE TRIGGER`), TRUNCATE append-only tables
  and read every schema. ADR 0039 (Finance unit, Proposed) keeps Finance out of the core schema,
  but the core could still read `finance` — the isolation is one-sided until the core stops
  running as the superuser (ADR 0039 §3 step 2).

## Decision

1. **One runtime role for the running core: `ayvo_core`** — `LOGIN NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`, no group membership, a connection limit
   (`CORE_DB_CONNECTION_LIMIT`, default 20). Only the `api` service uses it (the web app has no
   database connection; operator commands such as the admin bootstrap run in the `api` container
   and use it too).
2. **Rights = rows of the core schema, nothing else:** `SELECT, INSERT, UPDATE, DELETE` on every
   table of `public` except `_prisma_migrations`; `USAGE, SELECT, UPDATE` on its sequences;
   `EXECUTE` on its functions; `USAGE` (no `CREATE`) on `public`. Never TRUNCATE (it skips the
   DELETE triggers of append-only tables), REFERENCES, TRIGGER, DDL or any other schema. DELETE
   stays guarded where the history forbids it: the append-only triggers fire for this role.
3. **Privileged account only for privileged work:** migrations, the role setup, backups
   (`pg_dump`) and the Finance setup keep `POSTGRES_USER`; the running application never receives
   its password. The `migrate` service runs `prisma migrate deploy` and then
   `node dist/database/core-db-setup.js` (idempotent; re-applies exactly the rights above on every
   deploy, so a right granted by hand is taken back; default privileges give tables of later
   migrations the same rights at once).
4. **Secret:** `CORE_DB_PASSWORD` in the server env file only (DEV `dev-preview.env`, PROD
   `prod.env`), 24–128 URL-safe characters, never equal to `POSTGRES_PASSWORD`; the deploy scripts
   refuse otherwise. Set on every migration run (rotation = change the value and deploy).
5. **Proof before any deployment:** the whole API integration suite and the browser e2e run the
   application as such a role, created by the same setup (`test/support/global-setup.ts`,
   `scripts/start-e2e-server.mjs`). Test fixtures that need more (switching triggers off for
   "historical" data, test triggers, other databases) use the privileged account explicitly
   (`withPrivileged`); invariants that must hold even for it (TRUNCATE of append-only tables) are
   checked with it. `test/core-db-role.e2e.test.ts` checks the boundary itself: attributes, exact
   table rights, no TRUNCATE/DDL/trigger switching/migration history/other schema.

## Consequences

- With ADR 0039's Finance roles the isolation becomes two-sided: Finance cannot read `public`, the
  core cannot read `finance`. The shared host, PostgreSQL server, gateway and identity remain named
  shared failure domains.
- **Rollout (each step a separate owner approval):** add `CORE_DB_PASSWORD` to the server env →
  `deploy-dev.sh --check` → DEV deploy (the migrate step creates the role before `api` starts with
  it) → acceptance → the same commit on PROD. No new database, volume or `initdb`; live passwords
  are not changed.
- **Return:** deploy a commit without this change (`api` connects as `POSTGRES_USER` again) — no
  data change; the unused role may stay or be dropped later.
- A future feature that needs a privileged operation at runtime must say so in its own ADR; the
  answer is a migration or a separately run job, not a broader runtime role.
