import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { configureApp } from '../../src/app.setup.js';
import { FinanceAppModule } from '../../src/finance/finance-app.module.js';
import { FINANCE_ENV, loadFinanceEnv, type FinanceEnv } from '../../src/finance/finance-env.js';
import { FinancePrismaService } from '../../src/finance/finance-prisma.service.js';
import { FILE_STORAGE } from '../../src/storage/file-storage.js';
import { createTestApp, TEST_APP_ORIGIN, ControllableStorage, type TestApp } from './test-app.js';

export const financeDatabaseUrl = inject('financeDatabaseUrl');
export const financeOwnerDatabaseUrl = inject('financeOwnerDatabaseUrl');

/** The cookie the browser would send; with a superuser core any token is the test superuser. */
export const TEST_SESSION_COOKIE = 'ayvo_session=finance-test-session';

export interface FinanceTestApp {
  /** The Finance unit (its own Nest app, DB role, storage). */
  app: INestApplication;
  prisma: FinancePrismaService;
  storage: ControllableStorage;
  env: FinanceEnv;
  /** The core, listening on a real loopback port (the contract is real HTTP). */
  core: TestApp;
  /** Requests to Finance with a session cookie (and Origin on writes, like the browser). */
  get(path: string, cookie?: string): request.Test;
  post(path: string, cookie?: string): request.Test;
  close(): Promise<void>;
}

/**
 * The Finance unit as it runs (ADR 0039): its own app with only the Finance module, connected to
 * PostgreSQL as its runtime role (schema `finance` only) and to a real core over HTTP with the
 * service token. `coreOptions` select the core's identity (superuser by default, or real).
 */
export async function createFinanceTestApp(
  options: {
    core?: Parameters<typeof createTestApp>[2];
    coreUrl?: string;
    finance?: Partial<Record<string, string>>;
  } = {},
): Promise<FinanceTestApp> {
  if (!financeDatabaseUrl) throw new Error('No Finance test database');
  const token = randomBytes(32).toString('base64url');
  const core = await createTestApp(
    { FINANCE_SERVICE_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') },
    {},
    options.core,
  );
  await core.app.listen(0, '127.0.0.1');
  const port = (core.app.getHttpServer().address() as AddressInfo).port;
  // Several apps may share one directory, as several Finance processes share one bucket.
  const storageDir =
    options.finance?.FILE_STORAGE_DIR ?? (await mkdtemp(join(tmpdir(), 'ayvo-finance-files-')));
  const env = loadFinanceEnv({
    APP_ENV: 'test',
    FINANCE_DATABASE_URL: financeDatabaseUrl,
    CORE_INTERNAL_URL: options.coreUrl ?? `http://127.0.0.1:${port}`,
    FINANCE_SERVICE_TOKEN: token,
    FILE_STORAGE_DIR: storageDir,
    ...options.finance,
  });
  const storage = new ControllableStorage(storageDir);
  const moduleRef = await Test.createTestingModule({ imports: [FinanceAppModule] })
    .overrideProvider(FINANCE_ENV)
    .useValue(env)
    .overrideProvider(FILE_STORAGE)
    .useValue(storage)
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  const server = () => request(app.getHttpServer());
  return {
    app,
    prisma: app.get(FinancePrismaService),
    storage,
    env,
    core,
    get: (path, cookie = TEST_SESSION_COOKIE) => server().get(path).set('Cookie', cookie),
    post: (path, cookie = TEST_SESSION_COOKIE) =>
      server().post(path).set('Cookie', cookie).set('Origin', TEST_APP_ORIGIN),
    async close() {
      await app.close();
      await core.close();
    },
  };
}
