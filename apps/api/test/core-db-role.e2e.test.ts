import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreDbSetupStatements } from '../src/database/core-db-setup.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { databaseUrl, hasDatabase, withPrivileged } from './support/test-app.js';

/**
 * The running core's database role (ADR 0041), as created by the deployment's setup: it reads and
 * writes the rows of the core schema and can do nothing else — no TRUNCATE, no DDL, no switching
 * rules off, no migration history, no other schema (Finance). The whole API suite runs as this
 * role (test/support/global-setup.ts); this file checks the boundary itself.
 */
describe('core DB setup statements', () => {
  const core = { role: 'ayvo_core', password: 'a'.repeat(32), connections: 20 };

  it('grants row rights on the core schema only — never TRUNCATE, DDL or the migration history', () => {
    const sql = coreDbSetupStatements(core, 'ayvo').join('\n');
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "ayvo_core"',
    );
    expect(sql).toContain('REVOKE ALL ON TABLE public."_prisma_migrations" FROM "ayvo_core"');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM "ayvo_core"');
    expect(sql).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER|GRANT ALL|SCHEMA finance|\bSUPERUSER\b/);
  });

  it.each([
    ['a role name with a quote', { ...core, role: 'core"; DROP' }],
    ['a short password', { ...core, password: 'short' }],
    ['a password with a quote', { ...core, password: `${'a'.repeat(30)}'x` }],
    ['no connections', { ...core, connections: 0 }],
  ])('refuses %s', (_, bad) => {
    expect(() => coreDbSetupStatements(bad, 'ayvo')).toThrow();
  });
});

describe.skipIf(!hasDatabase)('the core runtime role in the database', () => {
  let core: PrismaClient;
  const id = randomBytes(4).toString('hex');
  const other = { role: `fin_iso_${id}`, schema: `finance_iso_${id}` };
  const later = `core_iso_later_${id}`;
  const role = decodeURIComponent(new URL(databaseUrl ?? 'postgresql://x@h/d').username);
  const denied = (p: Promise<unknown>, pattern = /permission denied|must be owner/) =>
    expect(p).rejects.toThrow(pattern);

  beforeAll(async () => {
    core = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    // Another unit's schema and a table of a later core migration, made by the privileged account.
    await withPrivileged(async (db) => {
      await db.$executeRawUnsafe(`CREATE ROLE "${other.role}" NOLOGIN`);
      await db.$executeRawUnsafe(`CREATE SCHEMA "${other.schema}" AUTHORIZATION "${other.role}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${other.schema}".docs (id int)`);
      await db.$executeRawUnsafe(`INSERT INTO "${other.schema}".docs VALUES (1)`);
      await db.$executeRawUnsafe(`CREATE TABLE public."${later}" (id int)`);
    });
  });
  afterAll(async () => {
    await core?.$disconnect();
    await withPrivileged(async (db) => {
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${later}"`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${other.schema}" CASCADE`);
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${other.role}"`);
    });
  });

  it('is the application connection and holds no special attribute or membership', async () => {
    const [me] = await core.$queryRaw<
      {
        user: string;
        super: boolean;
        createdb: boolean;
        createrole: boolean;
        repl: boolean;
        bypass: boolean;
        groups: number;
      }[]
    >`SELECT current_user AS "user", rolsuper AS "super", rolcreatedb AS createdb,
             rolcreaterole AS createrole, rolreplication AS repl, rolbypassrls AS bypass,
             (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS groups
        FROM pg_roles r WHERE rolname = current_user`;
    expect(me).toEqual({
      user: role,
      super: false,
      createdb: false,
      createrole: false,
      repl: false,
      bypass: false,
      groups: 0,
    });
  });

  it('has exactly SELECT/INSERT/UPDATE/DELETE on every core table but the migration history', async () => {
    const rows = await core.$queryRaw<{ table: string; rights: string }[]>`
      SELECT c.relname AS "table",
             string_agg(p.privilege_type, ',' ORDER BY p.privilege_type) AS rights
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        LEFT JOIN information_schema.role_table_grants p
          ON p.table_schema = 'public' AND p.table_name = c.relname AND p.grantee = current_user
       WHERE c.relkind IN ('r', 'p')
       GROUP BY c.relname`;
    expect(rows.length).toBeGreaterThan(50);
    for (const { table, rights } of rows) {
      expect([table, rights]).toEqual([
        table,
        table === '_prisma_migrations' ? null : 'DELETE,INSERT,SELECT,UPDATE',
      ]);
    }
  });

  it('reads and writes rows; a table of a later migration gets the same rights', async () => {
    expect(await core.site.count()).toBeGreaterThan(0);
    await core.$executeRawUnsafe(`INSERT INTO public."${later}" VALUES (1)`);
    expect(await core.$executeRawUnsafe(`DELETE FROM public."${later}"`)).toBe(1);
  });

  it('cannot TRUNCATE, change the schema, switch rules off or read the migration history', async () => {
    await denied(core.$executeRawUnsafe('TRUNCATE bottle_events'));
    await denied(core.$executeRawUnsafe(`TRUNCATE public."${later}"`));
    await denied(core.$executeRawUnsafe('CREATE TABLE public.core_may_not (id int)'));
    await denied(core.$executeRawUnsafe('ALTER TABLE bottle_events DISABLE TRIGGER ALL'));
    await denied(core.$executeRawUnsafe('DROP TABLE public.bottle_events'));
    await denied(
      core.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      }),
    );
    await denied(core.$queryRawUnsafe('SELECT count(*) FROM public."_prisma_migrations"'));
    await denied(core.$executeRawUnsafe('CREATE SCHEMA core_may_not'));
    await denied(core.$executeRawUnsafe('CREATE ROLE core_may_not'));
  });

  it("cannot see another unit's schema (Finance) — the other way round is Finance's own setup", async () => {
    await denied(core.$queryRawUnsafe(`SELECT * FROM "${other.schema}".docs`));
    await denied(core.$executeRawUnsafe(`INSERT INTO "${other.schema}".docs VALUES (2)`));
  });
});
