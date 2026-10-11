import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { FILE_STORAGE } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

/**
 * Provides the FileStorage implementation (ADR 0016). LocalFileStorage is DEV-only: there is no
 * silent fallback to container-local storage in production — startup fails instead.
 */
@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ENV],
      useFactory: (env: Env) => {
        if (env.APP_ENV === 'production') {
          throw new Error(
            'Production file storage is not configured: local storage is DEV-only (ADR 0016)',
          );
        }
        return new LocalFileStorage(env.FILE_STORAGE_DIR);
      },
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
