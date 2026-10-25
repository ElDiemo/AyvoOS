import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FILE_STORAGE } from '../storage/file-storage.js';
import { LocalFileStorage } from '../storage/local-file-storage.js';
import { createS3FileStorage } from '../storage/s3-file-storage.js';
import { CoreClient } from './core-client.js';
import { FinanceAccessGuard } from './finance-access.guard.js';
import { FINANCE_ENV, loadFinanceEnv, type FinanceEnv } from './finance-env.js';
import { FinanceModule } from './finance.module.js';

/** Finance's own environment and file storage (its prefixes in the same private bucket). */
@Global()
@Module({
  providers: [
    { provide: FINANCE_ENV, useFactory: () => loadFinanceEnv() },
    {
      provide: FILE_STORAGE,
      inject: [FINANCE_ENV],
      useFactory: async (env: FinanceEnv) => {
        if (env.FILE_STORAGE_DRIVER === 's3') return createS3FileStorage(env);
        if (env.APP_ENV === 'production')
          throw new Error('Production Finance storage is S3 only (ADR 0016)');
        return new LocalFileStorage(env.FILE_STORAGE_DIR);
      },
    },
    CoreClient,
  ],
  exports: [FINANCE_ENV, FILE_STORAGE, CoreClient],
})
export class FinanceRuntimeModule {}

/**
 * The Finance unit (ADR 0039): only the Finance feature, its environment, storage and the global
 * deny-by-default guard. No core module, worker or identity code is loaded in this process.
 */
@Module({
  imports: [FinanceRuntimeModule, FinanceModule],
  providers: [{ provide: APP_GUARD, useClass: FinanceAccessGuard }],
})
export class FinanceAppModule {}
