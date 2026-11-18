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
const TERMS = '20261118090100_sales_hotel_attributions';
const ENUM = '20261118090000_sales_hotel_attribution_enum_values';

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
 * The attribution migration (doc 068 PR 1b) is all or nothing: it runs in an explicit
 * transaction, so a failure after its first table, indexes, foreign keys and trigger were created
 * leaves no table, function or trigger behind and the migration unfinished. Same mechanism as
 * test/commission-terms-migration (PR 1a) and test/account-audience-migration (#136). The enum
 * value lives in its own earlier migration. Throw-away databases only.
 */
describe.skipIf(!hasDatabase)('the attribution migration is all or nothing', () => {
  const created: string[] = [];
  let admin: PrismaClient;
  let scratch: string;

  /** A new database migrated up to (excluding) the terms migration, and a client on it. */
  async function before(): Promise<{ url: string; db: PrismaClient }> {
    const name = `ayvo_attr_${Math.random().toString(16).slice(2, 10)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = Object.assign(new URL(adminDatabaseUrl!), { pathname: `/${name}` }).toString();
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(all.indexOf(ENUM)).toBe(all.indexOf(TERMS) - 1);
    const partial = await mkdtemp(join(scratch, 'before-attr-'));
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
        { tables: number; functions: number; triggers: number; finished: number }[]
      >(`SELECT (SELECT count(*)::int FROM pg_class WHERE relkind = 'r' AND relname IN
                  ('sales_hotel_attributions', 'sales_hotel_commission_terms')) AS tables,
                (SELECT count(*)::int FROM pg_proc
                  WHERE proname IN ('sales_hotel_attributions_insert',
                                    'sales_hotel_commission_terms_insert')
                    AND prosrc LIKE '%AYVO:%') AS functions,
                (SELECT count(*)::int FROM pg_trigger
                  WHERE tgname LIKE 'sales_hotel_%') AS triggers,
                (SELECT count(*)::int FROM "_prisma_migrations"
                  WHERE "migration_name" = '${TERMS}' AND "finished_at" IS NOT NULL) AS finished`);
      return row!;
    } finally {
      await db.$disconnect();
    }
  }

  const NOTHING = { tables: 0, functions: 0, triggers: 0, finished: 0 };

  /** After the cause is removed, the same migration applies whole and matches the schema. */
  async function recovers(url: string) {
    expect(prisma(['migrate', 'resolve', '--rolled-back', TERMS], url)).toBe(0);
    expect(prisma(['migrate', 'deploy'], url)).toBe(0);
    expect(await state(url)).toEqual({ tables: 2, functions: 2, triggers: 6, finished: 1 });
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
    scratch = await mkdtemp(join(tmpdir(), 'ayvo-attr-'));
  });
  afterAll(async () => {
    for (const name of created)
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    await rm(scratch, { recursive: true, force: true });
  });

  it('a failure after the first table and its trigger leaves nothing', async () => {
    const { url, db } = await before();
    try {
      // A function of the same name as the second table's makes its CREATE FUNCTION fail, after
      // sales_hotel_attributions, its indexes, foreign keys and triggers were created.
      await db.$executeRawUnsafe(
        `CREATE FUNCTION sales_hotel_commission_terms_insert() RETURNS trigger LANGUAGE plpgsql
           AS $$ BEGIN RETURN NEW; END $$`,
      );
      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await state(url)).toEqual(NOTHING);
      await db.$executeRawUnsafe(`DROP FUNCTION sales_hotel_commission_terms_insert()`);
      await recovers(url);
    } finally {
      await db.$disconnect();
    }
  });

  it('a failure in the middle of the first table rolls the whole file back', async () => {
    const { url, db } = await before();
    try {
      // Without the shared append-only function the first immutability trigger fails, after the
      // first table, its indexes, foreign keys and its insert function and trigger were created.
      await db.$executeRawUnsafe(`ALTER FUNCTION ayvo_reject_modification() RENAME TO ayvo_rm_tmp`);
      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await state(url)).toEqual(NOTHING);
      await db.$executeRawUnsafe(`ALTER FUNCTION ayvo_rm_tmp() RENAME TO ayvo_reject_modification`);
      await recovers(url);
    } finally {
      await db.$disconnect();
    }
  });
});
