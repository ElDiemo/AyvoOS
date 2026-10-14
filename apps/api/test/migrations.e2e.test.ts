import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { databaseUrl, hasDatabase } from './support/test-app.js';

const apiRoot = resolve(import.meta.dirname, '..');
const prismaBin = resolve(apiRoot, 'node_modules/.bin/prisma');
const migrationsDir = resolve(apiRoot, 'prisma/migrations');

/** Migration folders in apply order. */
async function migrationNames(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Runs the Prisma CLI against `url` (optionally with a custom config); returns the exit code. */
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
 * Migration checks on throw-away databases (never on a persistent one): schema drift, a clean
 * apply, and the stepwise path of an environment that already applied the first migration.
 */
describe.skipIf(!hasDatabase)('migrations', () => {
  const created: string[] = [];
  let admin: PrismaClient;
  let scratch: string;

  const newDatabase = async (): Promise<string> => {
    const name = `ayvo_mig_${Math.random().toString(16).slice(2, 10)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    return Object.assign(new URL(databaseUrl!), { pathname: `/${name}` }).toString();
  };

  beforeAll(async () => {
    const adminUrl = Object.assign(new URL(databaseUrl!), { pathname: '/postgres' }).toString();
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl }) });
    scratch = await mkdtemp(join(tmpdir(), 'ayvo-mig-'));
  });
  afterAll(async () => {
    for (const name of created)
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    await rm(scratch, { recursive: true, force: true });
  });

  it('the migrated test database has no drift from schema.prisma', () => {
    const code = prisma(
      [
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      databaseUrl!,
    );
    expect(code).toBe(0); // 0 = empty diff, 2 = drift
  });

  it('a clean (pre-Milestone-1) database applies all migrations', async () => {
    const url = await newDatabase();
    expect(prisma(['migrate', 'deploy'], url)).toBe(0);
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const applied = await client.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
    await client.$disconnect();
    expect(applied.map((m) => m.migration_name)).toEqual(await migrationNames());
  });

  it('a database that applied only the first migration upgrades with the rest', async () => {
    const url = await newDatabase();
    const all = await migrationNames();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const partial = join(scratch, 'migrations');
    await cp(join(migrationsDir, 'migration_lock.toml'), join(partial, 'migration_lock.toml'));
    await cp(join(migrationsDir, all[0]!), join(partial, all[0]!), { recursive: true });
    const config = join(scratch, 'prisma.config.ts');
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(join(apiRoot, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(partial)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    expect(prisma(['migrate', 'deploy', '--config', config], url)).toBe(0);
    expect(prisma(['migrate', 'deploy'], url)).toBe(0);
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
  });

  it('the crates migration keeps existing bottles unchanged and registers their QR tokens', async () => {
    const url = await newDatabase();
    const all = await migrationNames();
    const first = all.indexOf('20261014090000_crate_enum_values');
    expect(first).toBeGreaterThan(0);
    const partial = join(scratch, 'before-crates');
    await cp(join(migrationsDir, 'migration_lock.toml'), join(partial, 'migration_lock.toml'));
    for (const name of all.slice(0, first)) {
      await cp(join(migrationsDir, name), join(partial, name), { recursive: true });
    }
    const config = join(scratch, 'before-crates.config.ts');
    await writeFile(
      config,
      `export default { schema: ${JSON.stringify(join(apiRoot, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(partial)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    expect(prisma(['migrate', 'deploy', '--config', config], url)).toBe(0);

    // Synthetic history created before the migration: two bottles of one series.
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    try {
      await db.$executeRawUnsafe(`
        INSERT INTO "label_artworks" ("id", "format", "content_type", "byte_size", "sha256", "storage_key",
          "original_filename", "intrinsic_width", "intrinsic_height")
        VALUES ('01990000-0000-7000-8000-00000000a001', 'SVG', 'image/svg+xml', 10, repeat('a', 64),
          'label-artworks/2026/10/01990000-0000-7000-8000-00000000a001.svg', 'a.svg', 70, 110)`);
      await db.$executeRawUnsafe(`
        INSERT INTO "label_templates" ("id", "name") VALUES ('01990000-0000-7000-8000-00000000a002', 'mig-test')`);
      await db.$executeRawUnsafe(`
        INSERT INTO "label_template_versions" ("id", "template_id", "version_number", "width_mm", "height_mm", "artwork_id")
        VALUES ('01990000-0000-7000-8000-00000000a003', '01990000-0000-7000-8000-00000000a002', 1, 70, 110,
          '01990000-0000-7000-8000-00000000a001')`);
      await db.$executeRawUnsafe(`
        INSERT INTO "bottle_creation_batches" ("id", "serial", "code", "quantity_requested", "quantity_created",
          "label_template_version_id", "first_bottle_serial", "last_bottle_serial", "site_id")
        VALUES ('01990000-0000-7000-8000-00000000a004', 1, 'BC-000001', 2, 2,
          '01990000-0000-7000-8000-00000000a003', 1, 2, '01990000-0000-7000-8000-000000000001')`);
      await db.$executeRawUnsafe(`
        INSERT INTO "bottles" ("serial", "code", "public_token", "status", "creation_batch_id", "site_id") VALUES
          (1, 'AYV-B-000001', 'AAAAAAAAAAAAAAAAAAAAAA', 'CREATED', '01990000-0000-7000-8000-00000000a004', '01990000-0000-7000-8000-000000000001'),
          (2, 'AYV-B-000002', 'BBBBBBBBBBBBBBBBBBBBBB', 'CREATED', '01990000-0000-7000-8000-00000000a004', '01990000-0000-7000-8000-000000000001')`);
      const before = await db.$queryRawUnsafe<unknown[]>(
        `SELECT * FROM "bottles" ORDER BY "serial"`,
      );

      expect(prisma(['migrate', 'deploy'], url)).toBe(0);

      expect(await db.$queryRawUnsafe(`SELECT * FROM "bottles" ORDER BY "serial"`)).toEqual(before);
      expect(
        await db.$queryRawUnsafe(
          `SELECT "token", "kind"::text FROM "qr_identities" ORDER BY "token"`,
        ),
      ).toEqual([
        { token: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'BOTTLE' },
        { token: 'BBBBBBBBBBBBBBBBBBBBBB', kind: 'BOTTLE' },
      ]);
      for (const table of [
        'crates',
        'crate_registrations',
        'crate_events',
        'crate_label_print_jobs',
      ]) {
        expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`)).toEqual([
          { n: 0 },
        ]);
      }
    } finally {
      await db.$disconnect();
    }
  });
});
