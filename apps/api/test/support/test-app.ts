import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { ENV, loadEnv, type Env } from '../../src/config/env.js';
import { PrismaService } from '../../src/database/prisma.service.js';
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
  close(): Promise<void>;
}

export const databaseUrl = inject('testDatabaseUrl');
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
): Promise<TestApp> {
  if (!databaseUrl) throw new Error('No test database');
  const storageDir = await mkdtemp(join(tmpdir(), 'ayvo-files-'));
  const env: Env = {
    ...loadEnv({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://localhost:6379',
      PUBLIC_QR_BASE_URL: TEST_QR_BASE_URL,
      FILE_STORAGE_DIR: storageDir,
      LABEL_ARTWORK_MAX_BYTES: String(512 * 1024),
      ...rawEnv,
    }),
    ...processEnv,
  };
  const renderer = new ControllableRenderer();
  const storage = new ControllableStorage(storageDir);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RedisService)
    .useValue({ ping: () => Promise.resolve('PONG') })
    .overrideProvider(LabelPdfRenderer)
    .useValue(renderer)
    // Local storage directly: the real factory refuses to run with APP_ENV=production.
    .overrideProvider(FILE_STORAGE)
    .useValue(storage)
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    renderer,
    storage,
    env,
    close: async () => {
      await app.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
