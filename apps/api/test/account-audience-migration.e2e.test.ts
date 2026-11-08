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
const AUDIENCE = '20261112090000_account_audience';

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
 * The account audience migration (hotel portal PR 1) is atomic: it runs as one transaction with
 * its data check first, so a refusal — by that check, or by any statement after the DDL — leaves no
 * type, column, function or trigger behind and no catalogue row changed. Throw-away databases only.
 */
describe.skipIf(!hasDatabase)('the account audience migration is all or nothing', () => {
  const created: string[] = [];
  let admin: PrismaClient;
  let scratch: string;

  /** A new database migrated up to (excluding) the audience migration, and a client on it. */
  async function before(): Promise<{ url: string; db: PrismaClient }> {
    const name = `ayvo_aud_${Math.random().toString(16).slice(2, 10)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = Object.assign(new URL(adminDatabaseUrl!), { pathname: `/${name}` }).toString();
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const partial = await mkdtemp(join(scratch, 'before-audience-'));
    await cp(join(migrationsDir, 'migration_lock.toml'), join(partial, 'migration_lock.toml'));
    for (const m of all.slice(0, all.indexOf(AUDIENCE)))
      await cp(join(migrationsDir, m), join(partial, m), { recursive: true });
    const config = join(partial, 'prisma.config.ts');
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(join(apiRoot, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(partial)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    expect(prisma(['migrate', 'deploy', '--config', config], url)).toBe(0);
    return { url, db: new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) };
  }

  /** Nothing of the migration exists. */
  async function untouched(db: PrismaClient) {
    const [state] = await db.$queryRawUnsafe<
      { type: string | null; columns: number; functions: number; triggers: number; hotel: string }[]
    >(`SELECT to_regtype('"AccountAudience"')::text AS type,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name = 'audience') AS columns,
              (SELECT count(*)::int FROM pg_proc WHERE proname IN
                ('users_audience_immutable', 'roles_audience_rules', 'user_roles_audience',
                 'ayvo_audience_of_user')) AS functions,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE '%audience%') AS triggers,
              (SELECT row_to_json(r)::text FROM "roles" r WHERE r."code" = 'HOTEL_USER') AS hotel`);
    return state!;
  }

  const finished = async (db: PrismaClient) =>
    (
      await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "_prisma_migrations"
          WHERE "migration_name" = '${AUDIENCE}' AND "finished_at" IS NOT NULL`,
      )
    )[0]!.n;

  beforeAll(async () => {
    admin = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: Object.assign(new URL(adminDatabaseUrl!), {
          pathname: '/postgres',
        }).toString(),
      }),
    });
    scratch = await mkdtemp(join(tmpdir(), 'ayvo-aud-'));
  });
  afterAll(async () => {
    for (const name of created)
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    await rm(scratch, { recursive: true, force: true });
  });

  it('the preflight refuses an open HOTEL_USER grant: no DDL, then the fixed data migrates', async () => {
    const { url, db } = await before();
    try {
      const [user] = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "users" ("email", "display_name") VALUES ('legacy@ayvo.test', 'Legacy') RETURNING "id"`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "user_roles" ("user_id", "role_code", "grant_reason")
         VALUES ('${user!.id}', 'HOTEL_USER', 'a grant made before the rule')`,
      );
      const snapshot = await untouched(db);
      expect(snapshot).toMatchObject({ type: null, columns: 0, functions: 0, triggers: 0 });

      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await untouched(db)).toEqual(snapshot);
      expect(await finished(db)).toBe(0);

      // The owner resolves the data (never the migration): the grant is revoked; then it applies.
      await db.$executeRawUnsafe(
        `UPDATE "user_roles" SET "revoked_at" = now(), "revoke_reason" = 'resolved before the audience migration'
          WHERE "user_id" = '${user!.id}'`,
      );
      expect(prisma(['migrate', 'resolve', '--rolled-back', AUDIENCE], url)).toBe(0);
      expect(prisma(['migrate', 'deploy'], url)).toBe(0);
      expect(await finished(db)).toBe(1);
      const roles = await db.$queryRawUnsafe<{ code: string }[]>(
        `SELECT "code" FROM "roles" WHERE "audience" = 'PORTAL'`,
      );
      expect(roles.map((r) => r.code)).toEqual(['HOTEL_USER']);
      const [legacy] = await db.$queryRawUnsafe<{ audience: string }[]>(
        `SELECT "audience"::text FROM "users" WHERE "id" = '${user!.id}'`,
      );
      expect(legacy!.audience).toBe('STAFF');
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
    } finally {
      await db.$disconnect();
    }
  });

  it('a failure after the DDL rolls the whole migration back (one transaction)', async () => {
    const { url, db } = await before();
    try {
      // A function of the same name makes the migration's late CREATE FUNCTION fail, after the
      // type, the columns and the first triggers were already created in it.
      await db.$executeRawUnsafe(
        `CREATE FUNCTION ayvo_audience_of_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
      const snapshot = await untouched(db);
      expect(snapshot).toMatchObject({ type: null, columns: 0, triggers: 0 });

      expect(prisma(['migrate', 'deploy'], url)).not.toBe(0);
      expect(await untouched(db)).toEqual(snapshot);
      expect(await finished(db)).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
