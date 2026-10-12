#!/usr/bin/env node
// Starts the BUILT API for the web app's Playwright tests (apps/web/playwright.config.ts):
//   1. recreates the dedicated database `ayvo_e2e` on the dev PostgreSQL server (never the dev DB),
//   2. applies the committed migrations (`prisma migrate deploy`),
//   3. bootstraps the first administrator (e2e-admin@ayvo.test) with the one-time command,
//   4. adds a second, clearly fictional test site with its own warehouse (multi-site browser
//      tests; warehouses are created by migrations in v0.1, so the test database gets one here),
//   5. runs dist/main.js with a temporary file store and the fake identity provider (APP_ENV=test).
// Needs `pnpm build` and `pnpm infra:up`. Server credentials: AYVO_TEST_DATABASE_URL or the
// repository .env DATABASE_URL.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';

const apiRoot = resolve(import.meta.dirname, '..');
const envFile = resolve(apiRoot, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const serverUrl = process.env.AYVO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!serverUrl) throw new Error('Set DATABASE_URL (pnpm infra:up) or AYVO_TEST_DATABASE_URL');
const withDb = (db) => Object.assign(new URL(serverUrl), { pathname: `/${db}` }).toString();
const e2eUrl = withDb('ayvo_e2e');

const { PrismaClient } = await import(resolve(apiRoot, 'dist/generated/prisma/client.js'));
const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: withDb('postgres') }) });
await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "ayvo_e2e" WITH (FORCE)');
await admin.$executeRawUnsafe('CREATE DATABASE "ayvo_e2e"');
await admin.$disconnect();

execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
  cwd: apiRoot,
  env: { ...process.env, DATABASE_URL: e2eUrl },
  stdio: 'inherit',
});

const testEnv = {
  ...process.env,
  APP_ENV: 'test',
  AUTH_PROVIDER: 'test',
  DATABASE_URL: e2eUrl,
  APP_PUBLIC_ORIGIN: process.env.E2E_APP_ORIGIN ?? 'http://localhost:3100',
  // The browser tests sign in many times from one address.
  AUTH_RATE_LIMIT_LOGIN_MAX: '100000',
  AUTH_RATE_LIMIT_CALLBACK_MAX: '100000',
  AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '100000',
};
execFileSync(
  process.execPath,
  ['dist/identity/bootstrap-admin.js', '--email', 'e2e-admin@ayvo.test', '--name', 'E2E Admin'],
  { cwd: apiRoot, env: testEnv, stdio: 'inherit' },
);

// Test fixture only (this database is recreated for every run): a second site and warehouse.
const fixtures = new PrismaClient({ adapter: new PrismaPg({ connectionString: e2eUrl }) });
await fixtures.$executeRawUnsafe(`
  INSERT INTO "sites" ("id", "code", "name", "country_code", "address_line1", "postal_code", "city",
                       "time_zone", "default_locale", "default_currency", "capabilities")
  VALUES ('01990000-0000-7000-8000-0000000000e2', 'E2E-DE', 'Testovací provozovna DE', 'DE',
          'Teststraße 1', '10115', 'Berlin', 'Europe/Berlin', 'de-DE', 'EUR',
          ARRAY['WAREHOUSE', 'PRODUCTION']::"SiteCapability"[])`);
await fixtures.$executeRawUnsafe(`
  INSERT INTO "inventory_locations" ("code", "name", "site_id", "is_site_default")
  VALUES ('E2E-DE-W', 'Testovací sklad DE', '01990000-0000-7000-8000-0000000000e2', true)`);
await fixtures.$disconnect();

const port = process.env.E2E_API_PORT ?? '4100';
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: apiRoot,
  stdio: 'inherit',
  env: {
    ...testEnv,
    API_PORT: port,
    FILE_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'ayvo-e2e-files-')),
    PUBLIC_QR_BASE_URL: process.env.E2E_PUBLIC_QR_BASE_URL ?? 'http://localhost:3100/q',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
