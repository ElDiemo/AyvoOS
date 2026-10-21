import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Test-only access to the recreated `ayvo_e2e` database (never the dev database): prepares states
 * the UI cannot produce, e.g. a shipment labelled before a later feature existed. Uses the same
 * Prisma client and adapter as the e2e API server (apps/api/scripts/start-e2e-server.mjs).
 */
export async function e2eSql(statements: string[]): Promise<void> {
  const apiRoot = resolve(import.meta.dirname, '../../api');
  const envFile = resolve(apiRoot, '../../.env');
  if (!process.env.AYVO_TEST_DATABASE_URL && !process.env.DATABASE_URL && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const server = process.env.AYVO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!server) throw new Error('No database server for the e2e database');
  const url = Object.assign(new URL(server), { pathname: '/ayvo_e2e' }).toString();
  const require = createRequire(resolve(apiRoot, 'package.json'));
  const { PrismaPg } = (await import(require.resolve('@prisma/adapter-pg'))) as {
    PrismaPg: new (o: { connectionString: string }) => unknown;
  };
  const { PrismaClient } = (await import(resolve(apiRoot, 'dist/generated/prisma/client.js'))) as {
    PrismaClient: new (o: { adapter: unknown }) => {
      $executeRawUnsafe(sql: string): Promise<number>;
      $transaction(ops: Promise<number>[]): Promise<number[]>;
      $disconnect(): Promise<void>;
    };
  };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await db.$transaction(statements.map((s) => db.$executeRawUnsafe(s)));
  } finally {
    await db.$disconnect();
  }
}
