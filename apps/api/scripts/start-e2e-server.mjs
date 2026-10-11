#!/usr/bin/env node
// Starts the BUILT API for the web app's Playwright tests (apps/web/playwright.config.ts):
//   1. recreates the dedicated database `ayvo_e2e` on the dev PostgreSQL server (never the dev DB),
//   2. applies the committed migrations (`prisma migrate deploy`),
//   3. bootstraps the first administrator (e2e-admin@ayvo.test) with the one-time command,
//   4. runs dist/main.js with a temporary file store and the fake identity provider (APP_ENV=test).
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
};
execFileSync(
  process.execPath,
  ['dist/identity/bootstrap-admin.js', '--email', 'e2e-admin@ayvo.test', '--name', 'E2E Admin'],
  { cwd: apiRoot, env: testEnv, stdio: 'inherit' },
);

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
