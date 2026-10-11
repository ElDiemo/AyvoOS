import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
};

/** A production configuration that is complete except for what a test leaves out. */
const production = {
  ...valid,
  APP_ENV: 'production',
  PUBLIC_QR_BASE_URL: 'https://qr.ayvo.co',
  LABEL_QR_MIN_SIZE_MM: '15',
  LABEL_QR_ERROR_CORRECTION: 'Q',
};

describe('loadEnv', () => {
  it('applies defaults (non-production QR settings are the provisional candidates)', () => {
    expect(loadEnv(valid)).toMatchObject({
      APP_ENV: 'development',
      API_PORT: 4000,
      PUBLIC_QR_BASE_URL: 'http://localhost:3000/q',
      LABEL_QR_MIN_SIZE_MM: 10,
      LABEL_QR_ERROR_CORRECTION: 'Q',
      FILE_STORAGE_DRIVER: 'local',
    });
  });

  it('fails fast on missing DATABASE_URL', () => {
    expect(() => loadEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects APP_ENV values other than development, test, production (no staging yet)', () => {
    expect(() => loadEnv({ ...valid, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });

  describe('DEV / production QR separation (refuses to start)', () => {
    it('production with a DEV QR base URL', () => {
      expect(() => loadEnv({ ...production, PUBLIC_QR_BASE_URL: 'https://dev.ayvo.co/q' })).toThrow(
        /production requires the public QR base URL https:\/\/qr\.ayvo\.co/,
      );
    });

    it('production without a QR base URL', () => {
      const rest: Record<string, string | undefined> = {
        ...production,
        PUBLIC_QR_BASE_URL: undefined,
      };
      expect(() => loadEnv(rest)).toThrow(/PUBLIC_QR_BASE_URL is required in production/);
    });

    it.each(['development', 'test'])('%s with the production QR base URL', (APP_ENV) => {
      expect(() =>
        loadEnv({ ...valid, APP_ENV, PUBLIC_QR_BASE_URL: 'https://qr.ayvo.co' }),
      ).toThrow(/never encode a production QR URL/);
    });
  });

  it('requires physically validated QR settings in production (no defaults)', () => {
    expect(() => loadEnv({ ...production, LABEL_QR_MIN_SIZE_MM: undefined })).toThrow(
      /LABEL_QR_MIN_SIZE_MM/,
    );
    expect(() => loadEnv({ ...production, LABEL_QR_ERROR_CORRECTION: undefined })).toThrow(
      /LABEL_QR_ERROR_CORRECTION/,
    );
  });

  it('refuses to start production on local (container) file storage', () => {
    expect(() => loadEnv(production)).toThrow(/Production file storage is not configured/);
  });
});
