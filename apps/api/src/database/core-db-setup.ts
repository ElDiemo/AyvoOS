import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Core runtime DB role (ADR 0041; ADR 0039 §3 step 2), run by the deployment (and the tests) as
 * the privileged account, idempotently, AFTER the core migrations:
 *
 * - one login role for the running core (`api`): NOSUPERUSER, no databases/roles/replication, no
 *   RLS bypass; it is never an owner of anything;
 * - rights only on the core schema `public`: row reads/writes of its tables (SELECT, INSERT,
 *   UPDATE, DELETE — append-only tables stay guarded by their triggers), sequences, functions;
 * - never: TRUNCATE (skips DELETE triggers), REFERENCES/TRIGGER, DDL (no CREATE in `public`),
 *   the migration history `_prisma_migrations`, or any other schema (e.g. `finance`).
 *
 * Migrations, backups and setups keep the privileged account; the running application never gets
 * it. The password comes from the server env (never Git) and is set on every run (rotation =
 * change the env and redeploy).
 */
export interface CoreDbRole {
  role: string;
  password: string;
  /** Connection limit of the running core (pool size of each `api` process plus headroom). */
  connections: number;
}

const ROLE = /^[a-z][a-z0-9_]{2,62}$/;
const PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;
/** The rights of the running core on the rows of the core schema. */
const TABLE_RIGHTS = 'SELECT, INSERT, UPDATE, DELETE';

/** The setup statements for one database (validated name and password; idempotent). */
export function coreDbSetupStatements(core: CoreDbRole, database: string): string[] {
  if (!ROLE.test(core.role)) throw new Error(`Invalid core role name: ${core.role}`);
  if (!PASSWORD.test(core.password))
    throw new Error('Core DB password: 24–128 chars of [A-Za-z0-9_-]');
  if (!Number.isInteger(core.connections) || core.connections < 1)
    throw new Error('Invalid core connection limit');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('Invalid database name');

  const r = `"${core.role}"`;
  // Name and password are validated above (no quoting needed); DDL cannot take parameters.
  return [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${core.role}') THEN
        CREATE ROLE ${r} LOGIN;
      END IF;
    END $$`,
    `ALTER ROLE ${r} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT ${core.connections} PASSWORD '${core.password}'`,
    `GRANT CONNECT ON DATABASE "${database}" TO ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    // Exactly the row rights on every core table and nothing else (re-applied on every deploy, so a
    // right granted by hand is taken back).
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `GRANT ${TABLE_RIGHTS} ON ALL TABLES IN SCHEMA public TO ${r}`,
    `REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${r}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${r}`,
    // Tables of later migrations (run by this privileged account) get the same rights at once.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${TABLE_RIGHTS} ON TABLES TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${r}`,
    // No DDL in the core schema (PostgreSQL ≥ 15 default for PUBLIC, stated for this role).
    `REVOKE CREATE ON SCHEMA public FROM ${r}`,
  ];
}

export async function setupCoreDatabase(prisma: PrismaClient, core: CoreDbRole): Promise<void> {
  const database = (await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`)[0]!
    .db;
  for (const sql of coreDbSetupStatements(core, database)) await prisma.$executeRawUnsafe(sql);
}

/** `node dist/database/core-db-setup.js` — in the migrate container, as the privileged account. */
async function main(): Promise<void> {
  const env = process.env;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: need('DATABASE_URL') }),
  });
  try {
    await setupCoreDatabase(prisma, {
      role: env.CORE_DB_ROLE ?? 'ayvo_core',
      password: need('CORE_DB_PASSWORD'),
      connections: Number(env.CORE_DB_CONNECTION_LIMIT ?? 20),
    });
    console.log('core db setup: runtime role ready');
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`core db setup failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
