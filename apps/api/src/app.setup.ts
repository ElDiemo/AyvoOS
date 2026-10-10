import { API_BASE_PATH } from '@ayvo/types';
import type { INestApplication } from '@nestjs/common';

/**
 * HTTP-level configuration shared by `main.ts` and the e2e tests, so tests exercise the same
 * routes that are deployed. All routes live under `/api` (same-origin API, ADR 0013).
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_BASE_PATH);
  return app;
}
