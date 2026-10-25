import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { ENV, loadEnv, type Env } from '../../src/config/env.js';
import { PERMISSION_CODES, SYSTEM_ROLE_CODES } from '@ayvo/types';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Principal } from '../../src/identity/principal.js';
import { evaluateSites } from '../../src/identity/access.service.js';
import { PrincipalResolver } from '../../src/identity/principal-resolver.js';
import {
  LabelPdfRenderer,
  PdfLibLabelRenderer,
  type LabelPdfInput,
} from '../../src/labels/label-pdf-renderer.js';
import { RedisService } from '../../src/redis/redis.service.js';
import { FILE_STORAGE } from '../../src/storage/file-storage.js';
import { LocalFileStorage } from '../../src/storage/local-file-storage.js';

/** Test QR base URL: neither a DEV nor the production host. */
export const TEST_QR_BASE_URL = 'https://qr.example.test';
/** Origin of the (imaginary) web app in API tests. */
export const TEST_APP_ORIGIN = 'https://app.example.test';

/** Real renderer that can be told to fail, to simulate PDF generation errors. */
export class ControllableRenderer extends LabelPdfRenderer {
  failuresRemaining = 0;
  /** When set, the next render waits for this promise first (simulates a slow render). */
  gate: Promise<void> | null = null;
  private readonly real = new PdfLibLabelRenderer();

  async render(input: LabelPdfInput): Promise<Uint8Array> {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('Simulated renderer failure /internal/path/secret.svg');
    }
    return this.real.render(input);
  }
}

/** Real local storage whose writes can be told to fail (disk full, I/O error). */
export class ControllableStorage extends LocalFileStorage {
  failPutsRemaining = 0;

  constructor(readonly directory: string) {
    super(directory);
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    if (this.failPutsRemaining > 0) {
      this.failPutsRemaining -= 1;
      throw new Error('Simulated storage failure ENOSPC /var/lib/ayvo/files');
    }
    return super.put(key, data);
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  renderer: ControllableRenderer;
  storage: ControllableStorage;
  env: Env;
  /** The real Redis connection when created with `redis: 'real'`. */
  redis: RedisService;
  close(): Promise<void>;
}

/**
 * Domain tests run as a test "superuser": the request resolver is replaced IN THE TEST MODULE
 * ONLY by one that returns a principal with every permission, global site access and the site of
 * the MAIN warehouse as its active site. The
 * global access guard still runs and still enforces each route's declared rule. Identity tests
 * use `auth: 'real'` (sessions, cookies, the fake provider) instead.
 */
export const SUPERUSER_EMAIL = 'superuser@ayvo.test';

class SuperuserResolver {
  private principal: Promise<Principal> | null = null;
  constructor(private readonly prisma: PrismaService) {}

  resolve() {
    this.principal ??= (async () => {
      await this.prisma.$executeRaw`
        INSERT INTO "users" ("email", "display_name") VALUES (${SUPERUSER_EMAIL}, 'Test superuser')
        ON CONFLICT ("email") DO NOTHING`;
      const user = await this.prisma.user.findUniqueOrThrow({ where: { email: SUPERUSER_EMAIL } });
      // Global site access (like ADMIN), working at the site of the MAIN warehouse.
      const main = await this.prisma.inventoryLocation.findUniqueOrThrow({
        where: { code: 'MAIN' },
      });
      const sites = evaluateSites(
        await this.prisma.site.findMany({
          include: {
            locations: { select: { id: true, code: true, name: true, isSiteDefault: true } },
          },
          orderBy: { code: 'asc' },
        }),
        true,
        [],
      );
      return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        sessionId: '00000000-0000-4000-8000-000000000000',
        roles: SYSTEM_ROLE_CODES.map((code) => ({ code, name: code })),
        permissions: new Set(PERMISSION_CODES),
        globalSiteAccess: true,
        sites,
        activeSite: sites.find((site) => site.id === main.siteId)!,
        scopes: [],
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      } satisfies Principal;
    })();
    return this.principal.then((principal) => ({ kind: 'principal' as const, principal }));
  }

  /** A session forwarded by the Finance unit (ADR 0039): any token is the superuser here. */
  resolveToken(token: string | null) {
    return token ? this.resolve() : Promise.resolve({ kind: 'anonymous' as const });
  }
}

/** The application's connection: the core runtime role (non-superuser, ADR 0041). */
export const databaseUrl = inject('testDatabaseUrl');
/**
 * The privileged account of the test database — for fixtures the running core may not do
 * (historical data with triggers off, other databases) and for invariants that must hold even
 * for it (TRUNCATE of append-only tables). Never given to the application under test.
 */
export const adminDatabaseUrl = inject('testAdminDatabaseUrl');

/** Runs `fn` with a privileged client of the test database and closes it afterwards. */
export async function withPrivileged<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (!adminDatabaseUrl) throw new Error('No test database');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminDatabaseUrl }) });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
/** `describe.skipIf(!hasDatabase)` — only when AYVO_SKIP_DB_TESTS=1 was set explicitly. */
export const hasDatabase = databaseUrl !== null;

/**
 * The full API (all modules) against the per-run test database and a temporary file store.
 * `rawEnv` overrides variables BEFORE validation. `processEnv` overrides the validated config
 * AFTER it, to simulate a production or misconfigured process — bypassing the startup checks on
 * purpose, so the print-job guards are tested on their own.
 */
export async function createTestApp(
  rawEnv: Partial<Record<string, string>> = {},
  processEnv: Partial<Env> = {},
  options: { auth?: 'superuser' | 'real'; redis?: 'stub' | 'real' } = {},
): Promise<TestApp> {
  if (!databaseUrl) throw new Error('No test database');
  const storageDir = await mkdtemp(join(tmpdir(), 'ayvo-files-'));
  const env: Env = {
    ...loadEnv({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      PUBLIC_QR_BASE_URL: TEST_QR_BASE_URL,
      APP_PUBLIC_ORIGIN: TEST_APP_ORIGIN,
      // Synthetic native configuration for tests that explicitly simulate non-test config.
      AUTH_ENCRYPTION_KEY: '5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28', // synthetic test value
      AUTH_SMTP_HOST: 'smtp.example.test',
      AUTH_SMTP_USER: 'synthetic-user',
      AUTH_SMTP_PASSWORD: 'synthetic-password',
      AUTH_MAIL_FROM: 'noreply@ayvo.test',
      FILE_STORAGE_DIR: storageDir,
      LABEL_ARTWORK_MAX_BYTES: String(512 * 1024),
      // Sign-in limits are exercised by their own test with small values; everywhere else the
      // many test sign-ins from 127.0.0.1 must not trip them.
      AUTH_RATE_LIMIT_LOGIN_MAX: '100000',
      AUTH_RATE_LIMIT_CALLBACK_MAX: '100000',
      AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '100000',
      // Likewise the public passport limit (exercised in passport.e2e.test.ts with small values).
      PUBLIC_RATE_LIMIT_MAX: '100000',
      // Background rounds are driven by the tests themselves (doc 030): no sweeper, no waiting
      // between batch status reads after a simulated format change.
      PRINT_SWEEP_SECONDS: '0',
      CARRIER_LABEL_VARIANT_WAIT_MS: '0',
      ...rawEnv,
    }),
    ...processEnv,
  };
  const renderer = new ControllableRenderer();
  const storage = new ControllableStorage(storageDir);
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(LabelPdfRenderer)
    .useValue(renderer)
    // Local storage directly: the real factory refuses to run with APP_ENV=production.
    .overrideProvider(FILE_STORAGE)
    .useValue(storage);
  // Sign-in needs the rate limiter's Redis (it fails closed); superuser apps never sign in.
  if ((options.redis ?? (options.auth === 'real' ? 'real' : 'stub')) === 'stub') {
    builder = builder
      .overrideProvider(RedisService)
      .useValue({ ping: () => Promise.resolve('PONG') });
  }
  if ((options.auth ?? 'superuser') === 'superuser') {
    builder = builder.overrideProvider(PrincipalResolver).useFactory({
      factory: (prisma: PrismaService) => new SuperuserResolver(prisma),
      inject: [PrismaService],
    });
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    renderer,
    storage,
    env,
    redis: app.get(RedisService),
    close: async () => {
      await app.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
