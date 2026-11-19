import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { adminDatabaseUrl, hasDatabase } from './support/test-app.js';

const apiRoot = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(apiRoot, 'prisma/migrations');
const R3A = '20261119090000_bottle_fill_circulations';
const preflightSql = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/sql/reuse-r3a-rollback-preflight.sql'),
  'utf8',
);
const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(migrationsDir, name, 'migration.sql')))
    .digest('hex');
/** The reviewed list of the preflight: name → [checksum, classification]. */
const reviewed = new Map(
  [
    ...preflightSql.matchAll(/\('(\d{14}_[a-z0-9_]+)',\s*'([0-9a-f]{64})',\s*'([A-Z0-9_]+)'\)/g),
  ].map((m) => [m[1]!, [m[2]!, m[3]!] as const]),
);
const repoMigrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

interface Preflight {
  verdict: string;
  later_migrations: string;
  reuse_members: number;
  reuse_anchored: number;
  filled: number;
  anchored: number;
}
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * The R3-a rollback preflight (doc 058 §Rollback 1, scripts/sql/reuse-r3a-rollback-preflight.sql)
 * on a throw-away database with every migration of this branch. A later migration stops the
 * rollback by its real relation to R3-a — never because of its name alone — and fail closed: one
 * that is not in the reviewed list with its exact checksum stops it. Each scenario writes its
 * `_prisma_migrations` rows (what the preflight reads) in a transaction that is rolled back.
 */
describe.skipIf(!hasDatabase)(
  'R3-a rollback preflight: later migrations by their dependency',
  () => {
    let admin: PrismaClient;
    let db: PrismaClient;
    const name = `ayvo_r3a_pf_${Math.random().toString(16).slice(2, 10)}`;
    class Rollback extends Error {}

    /**
     * Runs the preflight read-only after `setup` and rolls everything back. `base: 'r3a'` starts
     * from a database that recorded R3-a as its latest migration (the later ones of this branch,
     * if any, are taken out of `_prisma_migrations` first); `'branch'` from this branch as deployed.
     */
    const preflight = async (
      setup: (tx: Tx) => Promise<unknown> = async () => {},
      { base = 'r3a' }: { base?: 'r3a' | 'branch' } = {},
    ) => {
      let result: Preflight | undefined;
      await db
        .$transaction(async (tx) => {
          if (base === 'r3a')
            await tx.$executeRawUnsafe(
              `DELETE FROM _prisma_migrations WHERE migration_name > $1`,
              R3A,
            );
          await setup(tx);
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          [result] = await tx.$queryRawUnsafe<Preflight[]>(preflightSql);
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
      return result!;
    };
    /** A recorded migration as Prisma writes it (`finished: false` = a failed one). */
    const applied = (
      tx: Tx,
      migration: string,
      checksum: string,
      { finished = true, startedAt = 'now()' }: { finished?: boolean; startedAt?: string } = {},
    ) =>
      tx.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, $1, $2, ${startedAt}, ${finished ? 'now()' : 'NULL'}, ${finished ? 1 : 0})`,
        checksum,
        migration,
      );
    const reviewedChecksum = (migration: string) => reviewed.get(migration)![0];
    const COMMISSIONS = '20261119180000_finance_commissions_permission';
    const R3B = [
      '20261119090100_reuse_placement_enum_values',
      '20261119090200_reuse_placement_filling',
    ];

    beforeAll(async () => {
      const adminUrl = Object.assign(new URL(adminDatabaseUrl!), { pathname: '/postgres' });
      admin = new PrismaClient({
        adapter: new PrismaPg({ connectionString: adminUrl.toString() }),
      });
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      const url = Object.assign(new URL(adminDatabaseUrl!), { pathname: `/${name}` }).toString();
      execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
        cwd: apiRoot,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    }, 180_000);
    afterAll(async () => {
      await db?.$disconnect();
      await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin?.$disconnect();
    });

    it('the reviewed checksums are what Prisma records, and every later migration of the repo is reviewed', async () => {
      const [r3a] = await db.$queryRawUnsafe<{ checksum: string }[]>(
        `SELECT checksum FROM _prisma_migrations WHERE migration_name = $1`,
        R3A,
      );
      expect(r3a!.checksum).toBe(sha256(R3A));
      // A later migration in the repo that the list does not name (or names with another checksum)
      // would stop every rollback: the list must be updated in the same PR, after checking its SQL.
      for (const m of repoMigrations.filter((x) => x > R3A))
        expect(reviewed.get(m)?.[0], `${m} is not reviewed in the preflight`).toBe(sha256(m));
      // INDEPENDENT is checked against the SQL where the repo has it: it names no R3-a object.
      for (const [m, [, kind]] of reviewed)
        if (kind === 'INDEPENDENT' && repoMigrations.includes(m))
          expect(readFileSync(resolve(migrationsDir, m, 'migration.sql'), 'utf8')).not.toMatch(
            /bottle_fill_circulation|bottle_events_fill_circulation/,
          );
    });

    it('only R3-a deployed: the rollback is allowed', async () => {
      expect(await preflight()).toEqual({
        verdict: 'ROLLBACK_ALLOWED',
        later_migrations: '',
        reuse_members: 0,
        reuse_anchored: 0,
        filled: 0,
        anchored: 0,
      });
    });

    it('a later independent migration (commissions 2a, later prefix) does not stop it', async () => {
      expect(
        await preflight((tx) => applied(tx, COMMISSIONS, reviewedChecksum(COMMISSIONS))),
      ).toMatchObject({
        verdict: 'ROLLBACK_ALLOWED',
        later_migrations: `${COMMISSIONS}=INDEPENDENT`,
      });
    });

    it('fail closed: another checksum, an unknown, a failed or a late-applied earlier migration stops it', async () => {
      const other = 'f'.repeat(64);
      expect(await preflight((tx) => applied(tx, COMMISSIONS, other))).toMatchObject({
        verdict: 'STOP_UNVERIFIED_MIGRATION',
        later_migrations: `${COMMISSIONS}=UNVERIFIED`,
      });
      expect(
        await preflight((tx) => applied(tx, '20261201090000_something_new', other)),
      ).toMatchObject({ verdict: 'STOP_UNVERIFIED_MIGRATION' });
      expect(
        await preflight((tx) =>
          applied(tx, COMMISSIONS, reviewedChecksum(COMMISSIONS), { finished: false }),
        ),
      ).toMatchObject({ verdict: 'STOP_UNVERIFIED_MIGRATION' });
      // Named before R3-a but applied after it (a branch merged later): never assumed independent.
      expect(
        await preflight((tx) =>
          applied(tx, '20261118120000_merged_late', other, {
            startedAt: "now() + interval '1 hour'",
          }),
        ),
      ).toMatchObject({
        verdict: 'STOP_UNVERIFIED_MIGRATION',
        later_migrations: '20261118120000_merged_late=UNVERIFIED',
      });
    });

    it('R3-b recorded (alone or with an independent one): it depends on R3-a, doc 059 applies', async () => {
      expect(
        await preflight(async (tx) => {
          for (const m of R3B) await applied(tx, m, reviewedChecksum(m));
          await applied(tx, COMMISSIONS, reviewedChecksum(COMMISSIONS));
        }),
      ).toMatchObject({
        verdict: 'STOP_DEPENDENT_DEPLOYED',
        later_migrations: `${R3B[0]}=DEPENDS_R3B, ${R3B[1]}=DEPENDS_R3B, ${COMMISSIONS}=INDEPENDENT`,
      });
    });

    const laterInRepo = repoMigrations.filter((m) => m > R3A);
    it('this branch as deployed: each later migration by its classification', async () => {
      const expected = laterInRepo.map((m) => `${m}=${reviewed.get(m)![1]}`);
      const dependent = laterInRepo.some((m) => reviewed.get(m)![1].startsWith('DEPENDS_'));
      const verdict = dependent ? 'STOP_DEPENDENT_DEPLOYED' : 'ROLLBACK_ALLOWED';
      expect(await preflight(undefined, { base: 'branch' })).toMatchObject({
        verdict,
        later_migrations: expected.join(', '),
      });
      // With a later independent one deployed as well: unchanged.
      expect(
        await preflight((tx) => applied(tx, COMMISSIONS, reviewedChecksum(COMMISSIONS)), {
          base: 'branch',
        }),
      ).toMatchObject({
        verdict,
        later_migrations: [...expected, `${COMMISSIONS}=INDEPENDENT`].sort().join(', '),
      });
    });

    it.runIf(laterInRepo.includes(R3B[1]!))(
      'R3-b applied for real: its first write (a REUSE member alone) means fix forward only',
      async () => {
        expect(
          await preflight(
            async (tx) => {
              // A REUSE member with nothing filled yet (review 5829606688). The triggers and FKs
              // are off only to place this one row without a whole crate scenario.
              await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
              await tx.$executeRawUnsafe(
                `INSERT INTO crate_assignments (cycle_id, cycle_capacity, bottle_id, ordinal, source,
                   assigned_by, operation_request_id, assigned_event_id)
                 VALUES (gen_random_uuid(), 1, gen_random_uuid(), 1, 'REUSE', gen_random_uuid(),
                   gen_random_uuid(), gen_random_uuid())`,
              );
            },
            { base: 'branch' },
          ),
        ).toMatchObject({ verdict: 'FIX_FORWARD', reuse_members: 1, reuse_anchored: 0 });
      },
    );

    it('a FILLED without its anchor stops it (filled <> anchored)', async () => {
      expect(
        await preflight(async (tx) => {
          // Only possible with the triggers (and FKs) off — exactly the damage (c) must catch.
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
          await tx.$executeRawUnsafe(
            `INSERT INTO bottle_events (bottle_id, type, occurred_at) VALUES (gen_random_uuid(), 'FILLED', now())`,
          );
        }),
      ).toMatchObject({ verdict: 'STOP_ANCHORS', filled: 1, anchored: 0 });
    });
  },
);
