import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { TestProject } from 'vitest/node';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Creates a throw-away PostgreSQL database for this test run, applies the committed migrations
 * with `prisma migrate deploy` (exactly like a deployment), and drops it afterwards.
 *
 * Server: AYVO_TEST_DATABASE_URL, else DATABASE_URL (repository .env; `pnpm infra:up`). Only the
 * server/credentials are used; the database itself is always a new `ayvo_test_<random>` one.
 * Set AYVO_SKIP_DB_TESTS=1 to skip database tests explicitly (they are never skipped silently).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string | null;
  }
}

const apiRoot = resolve(import.meta.dirname, '../..');

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.AYVO_SKIP_DB_TESTS === '1') {
    console.warn('AYVO_SKIP_DB_TESTS=1: database integration tests are SKIPPED');
    project.provide('testDatabaseUrl', null);
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

  const dbName = `ayvo_test_${randomBytes(6).toString('hex')}`;
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
  project.provide('testDatabaseUrl', testUrl);

  return async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$disconnect();
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
