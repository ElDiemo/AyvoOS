import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { TestProject } from 'vitest/node';
import { setupFinanceDatabase } from '../../src/finance/db-setup.js';
import { setupCoreDatabase } from '../../src/database/core-db-setup.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Creates a throw-away PostgreSQL database for this test run, applies the committed migrations
 * with `prisma migrate deploy` (exactly like a deployment), and drops it afterwards.
 *
 * Server: AYVO_TEST_DATABASE_URL, else DATABASE_URL (repository .env; `pnpm infra:up`). Only the
 * server/credentials are used; the database itself is always a new `ayvo_test_<random>` one.
 * Set AYVO_SKIP_DB_TESTS=1 to skip database tests explicitly (they are never skipped silently).
 *
 * The application under test connects like the deployed core (ADR 0041): as its own non-superuser
 * runtime role, created for this run by the same setup a deployment runs (`testDatabaseUrl`).
 * Migrations and test fixtures that need more (switching triggers off, other databases) use the
 * privileged account (`testAdminDatabaseUrl`) — never the application's connection.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string | null;
    /** Finance unit (ADR 0039): its runtime role and its schema owner, per run. */
    financeDatabaseUrl: string | null;
    financeOwnerDatabaseUrl: string | null;
    testAdminDatabaseUrl: string | null;
  }
}

const apiRoot = resolve(import.meta.dirname, '../..');

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.AYVO_SKIP_DB_TESTS === '1') {
    console.warn('AYVO_SKIP_DB_TESTS=1: database integration tests are SKIPPED');
    project.provide('testDatabaseUrl', null);
    project.provide('financeDatabaseUrl', null);
    project.provide('financeOwnerDatabaseUrl', null);
    project.provide('testAdminDatabaseUrl', null);
    return;
  }
  const envFile = resolve(apiRoot, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const serverUrl = process.env.AYVO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!serverUrl) {
    throw new Error(
      'Database tests need PostgreSQL: set DATABASE_URL (pnpm infra:up) or AYVO_TEST_DATABASE_URL, ' +
        'or AYVO_SKIP_DB_TESTS=1 to skip them explicitly.',
    );
  }

  const suffix = randomBytes(6).toString('hex');
  const dbName = `ayvo_test_${suffix}`;
  // Roles are cluster-wide: one per run, removed with the database.
  const coreRole = `ayvo_core_test_${suffix}`;
  const corePassword = randomBytes(24).toString('base64url');
  const adminUrl = withDatabase(serverUrl, 'postgres');
  const testUrl = withDatabase(serverUrl, dbName);

  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl }) });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (error) {
    await admin.$disconnect();
    throw new Error(
      `Cannot create the test database on ${new URL(serverUrl).host} (is PostgreSQL running? ` +
        `pnpm infra:up): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  const privileged = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl }) });
  try {
    await setupCoreDatabase(privileged, {
      role: coreRole,
      password: corePassword,
      connections: 50,
    });
  } finally {
    await privileged.$disconnect();
  }
  project.provide('testDatabaseUrl', withRole(testUrl, coreRole, corePassword));
  project.provide('testAdminDatabaseUrl', testUrl);

  // Finance (ADR 0039): its roles for this run only, its schema and migrations — exactly as the
  // deployment does it (db-setup as the superuser, migrations as the schema owner).
  const roles = {
    ownerRole: `ayvo_fin_${suffix}_owner`,
    ownerPassword: randomBytes(24).toString('hex'),
    runtimeRole: `ayvo_fin_${suffix}`,
    runtimePassword: randomBytes(24).toString('hex'),
    runtimeConnections: 20,
  };
  const testDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl }) });
  try {
    await setupFinanceDatabase(testDb, roles);
  } finally {
    await testDb.$disconnect();
  }
  const ownerUrl = withRole(testUrl, roles.ownerRole, roles.ownerPassword);
  execFileSync(
    resolve(apiRoot, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--config', 'prisma-finance.config.ts'],
    {
      cwd: apiRoot,
      env: { ...process.env, FINANCE_MIGRATE_DATABASE_URL: `${ownerUrl}?schema=finance` },
      stdio: 'pipe',
    },
  );
  project.provide('financeOwnerDatabaseUrl', ownerUrl);
  project.provide(
    'financeDatabaseUrl',
    withRole(testUrl, roles.runtimeRole, roles.runtimePassword),
  );

  return async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    // This run's Finance login roles only (the shared NOLOGIN group stays).
    for (const role of [roles.runtimeRole, roles.ownerRole])
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${coreRole}"`);
    await admin.$disconnect();
  };
}

function withRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
