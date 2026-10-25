import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Finance DB setup (ADR 0039 §3), run by the deployment (and the tests) as the database
 * superuser, idempotently, before the Finance migrations:
 *
 * - group `ayvo_finance_rw` (NOLOGIN) — the rights the migrations grant (rows of `finance` only);
 * - owner login role — owns schema `finance`, runs its migrations, nothing outside it;
 * - runtime login role — member of the group: SELECT / INSERT / UPDATE on Finance tables only.
 *
 * Neither login role is superuser, may create databases or roles, or bypass RLS; neither gets
 * any right on the core schema `public` (its tables are owned by the core and granted to nobody).
 * Passwords come from the server env (never Git), are validated, and are set on every run
 * (rotation = change the env and redeploy).
 */
export interface FinanceDbRoles {
  ownerRole: string;
  ownerPassword: string;
  runtimeRole: string;
  runtimePassword: string;
  /** Connection limits (ADR 0039 §2, proposals to measure). */
  runtimeConnections: number;
}

const ROLE = /^[a-z][a-z0-9_]{2,62}$/;
const PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;
export const FINANCE_GROUP_ROLE = 'ayvo_finance_rw';

export async function setupFinanceDatabase(
  prisma: PrismaClient,
  roles: FinanceDbRoles,
): Promise<void> {
  for (const role of [roles.ownerRole, roles.runtimeRole])
    if (!ROLE.test(role)) throw new Error(`Invalid Finance role name: ${role}`);
  for (const pw of [roles.ownerPassword, roles.runtimePassword])
    if (!PASSWORD.test(pw)) throw new Error('Finance DB passwords: 24–128 chars of [A-Za-z0-9_-]');
  if (!Number.isInteger(roles.runtimeConnections) || roles.runtimeConnections < 1)
    throw new Error('Invalid Finance connection limit');
  const database = (await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`)[0]!
    .db;

  // Names and passwords are validated above (no quoting needed); DDL cannot take parameters.
  const ensureRole = (name: string, attributes: string) => `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN
        CREATE ROLE "${name}" ${attributes};
      END IF;
    END $$`;
  const statements = [
    ensureRole(FINANCE_GROUP_ROLE, 'NOLOGIN'),
    `ALTER ROLE "${FINANCE_GROUP_ROLE}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    ensureRole(roles.ownerRole, 'LOGIN'),
    `ALTER ROLE "${roles.ownerRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2 PASSWORD '${roles.ownerPassword}'`,
    ensureRole(roles.runtimeRole, 'LOGIN'),
    `ALTER ROLE "${roles.runtimeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT CONNECTION LIMIT ${roles.runtimeConnections} PASSWORD '${roles.runtimePassword}'`,
    `GRANT "${FINANCE_GROUP_ROLE}" TO "${roles.runtimeRole}"`,
    `CREATE SCHEMA IF NOT EXISTS "finance" AUTHORIZATION "${roles.ownerRole}"`,
    `ALTER SCHEMA "finance" OWNER TO "${roles.ownerRole}"`,
    `REVOKE ALL ON SCHEMA "finance" FROM PUBLIC`,
    // Nothing of the core: no CREATE in public (PostgreSQL ≥ 15 default, stated explicitly), no
    // temporary tables, and no right on any existing core table, sequence or function grant.
    `REVOKE CREATE ON SCHEMA public FROM "${roles.ownerRole}", "${roles.runtimeRole}", "${FINANCE_GROUP_ROLE}"`,
    `REVOKE TEMPORARY ON DATABASE "${database}" FROM "${roles.ownerRole}", "${roles.runtimeRole}"`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${roles.ownerRole}", "${roles.runtimeRole}", "${FINANCE_GROUP_ROLE}"`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "${roles.ownerRole}", "${roles.runtimeRole}", "${FINANCE_GROUP_ROLE}"`,
  ];
  for (const sql of statements) await prisma.$executeRawUnsafe(sql);
}

/** `node dist/finance/db-setup.js` — in the migrate container, as the superuser (DATABASE_URL). */
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
    await setupFinanceDatabase(prisma, {
      ownerRole: env.FINANCE_DB_OWNER_ROLE ?? 'ayvo_finance_owner',
      ownerPassword: need('FINANCE_DB_OWNER_PASSWORD'),
      runtimeRole: env.FINANCE_DB_ROLE ?? 'ayvo_finance',
      runtimePassword: need('FINANCE_DB_PASSWORD'),
      runtimeConnections: Number(env.FINANCE_DB_CONNECTION_LIMIT ?? 5),
    });
    console.log('finance db setup: roles and schema ready');
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`finance db setup failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
