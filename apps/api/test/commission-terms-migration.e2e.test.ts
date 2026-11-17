import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { adminDatabaseUrl, hasDatabase } from './support/test-app.js';

const apiRoot = resolve(import.meta.dirname, '..');
const prismaBin = resolve(apiRoot, 'node_modules/.bin/prisma');
const migrationsDir = resolve(apiRoot, 'prisma/migrations');
const TERMS = '20261117090100_commission_terms';
const ENUM = '20261117090000_commission_terms_enum_values';

function prisma(args: string[], url: string): number {
  try {
    execFileSync(prismaBin, args, {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

/**
 * The commission terms migration (doc 068 PR 1a, PROTOTYPE) is atomic: Prisma applies the file as
 * one transaction, so a failure after its catalogue writes (the permission and its ADMIN grant)
 * leaves no permission without its table, no grant, no table, function or trigger, and the
 * catalogue switch off. Same mechanism as test/account-audience-migration (#136). The enum value
 * lives in its own earlier migration (ALTER TYPE … ADD VALUE) and is not part of this check.
 * Throw-away databases only.
 */
describe.skipIf(!hasDatabase)('the commission terms migration is all or nothing', () => {
  const created: string[] = [];
  let admin: PrismaClient;
  let scratch: string;

  /** A new database migrated up to (excluding) the terms migration, and a client on it. */
  async function before(): Promise<{ url: string; db: PrismaClient }> {
    const name = `ayvo_terms_${Math.random().toString(16).slice(2, 10)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = Object.assign(new URL(adminDatabaseUrl!), { pathname: `/${name}` }).toString();
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(all.indexOf(ENUM)).toBe(all.indexOf(TERMS) - 1);
    const partial = await mkdtemp(join(scratch, 'before-terms-'));
    await cp(join(migrationsDir, 'migration_lock.toml'), join(partial, 'migration_lock.toml'));
    for (const m of all.slice(0, all.indexOf(TERMS)))
      await cp(join(migrationsDir, m), join(partial, m), { recursive: true });
    const config = join(partial, 'prisma.config.ts');
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(join(apiRoot, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(partial)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    expect(prisma(['migrate', 'deploy', '--config', config], url)).toBe(0);
    return { url, db: new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) };
  }

  /** What the migration would leave behind (a fresh connection: session settings included). */
  async function state(url: string) {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    try {
      const [row] = await db.$queryRawUnsafe<
        {
          permission: number;
          grants: number;
          table: string | null;
          functions: number;
          triggers: number;
          catalogue: string | null;
          finished: number;
        }[]
      >(`SELECT (SELECT count(*)::int FROM "permissions"
                  WHERE "code" = 'sales:commission_terms_manage') AS permission,
                (SELECT count(*)::int FROM "role_permissions"
                  WHERE "permission_code" = 'sales:commission_terms_manage') AS grants,
                to_regclass('public.sales_commission_terms')::text AS "table",
                (SELECT count(*)::int FROM pg_proc
                  WHERE proname = 'sales_commission_terms_insert'
                    AND prosrc LIKE '%versions follow each other%') AS functions,
                (SELECT count(*)::int FROM pg_trigger
                  WHERE tgname LIKE 'sales_commission_terms%') AS triggers,
                current_setting('ayvo.catalogue_migration', true) AS catalogue,
                (SELECT count(*)::int FROM "_prisma_migrations"
                  WHERE "migration_name" = '${TERMS}' AND "finished_at" IS NOT NULL) AS finished`);
      return row!;
    } finally {
      await db.$disconnect();
    }
  }

  const NOTHING = { permission: 0, grants: 0, table: null, functions: 0, triggers: 0, finished: 0 };

  /** After the cause is removed, the same migration applies whole and matches the schema. */
  async function recovers(url: string) {
    expect(prisma(['migrate', 'resolve', '--rolled-back', TERMS], url)).toBe(0);
    expect(prisma(['migrate', 'deploy'], url)).toBe(0);
    expect(await state(url)).toMatchObject({
      permission: 1,
      grants: 1,
      table: 'sales_commission_terms',
      functions: 1,
      triggers: 3,
      finished: 1,
    });
    expect(
      prisma(
        [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        url,
      ),
    ).toBe(0);
  }

  beforeAll(async () => {
    admin = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: Object.assign(new URL(adminDatabaseUrl!), {
          pathname: '/postgres',
        }).toString(),
      }),
    });
    scratch = await mkdtemp(join(tmpdir(), 'ayvo-terms-'));
  });
  afterAll(async () => {
    for (const name of created)
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    await rm(scratch, { recursive: true, force: true });
  });

  it('a failure right after the catalogue writes leaves no permission and no grant', async () => {
    const { url, db } = await before();
    try {
      // A table of the same name makes CREATE TABLE — the first statement after the permission
      // and its ADMIN grant were inserted and the catalogue switched off — fail.
      await db.$executeRawUnsafe(`CREATE TABLE "sales_commission_terms" ("x" int)`);
      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await state(url)).toMatchObject({ ...NOTHING, table: 'sales_commission_terms' });
      expect((await state(url)).catalogue ?? '').not.toBe('on');
      await db.$executeRawUnsafe(`DROP TABLE "sales_commission_terms"`);
      await recovers(url);
    } finally {
      await db.$disconnect();
    }
  });

  it('a failure late in the file rolls the whole migration back (one transaction)', async () => {
    const { url, db } = await before();
    try {
      // A function of the same name makes the late CREATE FUNCTION fail, after the catalogue
      // writes, the table, its indexes and foreign keys were already created in the migration.
      await db.$executeRawUnsafe(
        `CREATE FUNCTION sales_commission_terms_insert() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN RETURN NEW; END $$`,
      );
      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await state(url)).toMatchObject(NOTHING);
      expect((await state(url)).catalogue ?? '').not.toBe('on');
      await db.$executeRawUnsafe(`DROP FUNCTION sales_commission_terms_insert()`);
      await recovers(url);
    } finally {
      await db.$disconnect();
    }
  });
});
