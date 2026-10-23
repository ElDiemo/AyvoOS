import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
  // Obviously fake identity-provider settings (development requires the real provider).
  WORKOS_API_KEY: 'sk_test_not_a_real_key',
  WORKOS_CLIENT_ID: 'client_not_a_real_id',
  WORKOS_JWT_ISSUER: 'https://auth.workos.example',
};

/** A production configuration that is complete except for what a test leaves out. */
const production = {
  ...valid,
  APP_ENV: 'production',
  PUBLIC_QR_BASE_URL: 'https://qr.ayvo.co',
  LABEL_QR_MIN_SIZE_MM: '15',
  LABEL_QR_ERROR_CORRECTION: 'Q',
  APP_PUBLIC_ORIGIN: 'https://app.ayvo.example',
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

  describe('explicit production S3 storage', () => {
    const s3 = {
      FILE_STORAGE_DRIVER: 's3',
      AWS_REGION: 'eu-north-1',
      AWS_ACCESS_KEY_ID: 'AKIAFAKE000000000000',
      AWS_SECRET_ACCESS_KEY: 'fakeOnlyNotARealAwsSecret00000000000000000',
      S3_BUCKET: 'ayvo-test-files',
      S3_EXPECTED_BUCKET_OWNER: '123456789012',
    };

    it('accepts explicit S3 config without bypassing any other production guard', () => {
      expect(loadEnv({ ...production, ...s3 })).toMatchObject(s3);
      expect(() => loadEnv({ ...production, ...s3, AUTH_PROVIDER: 'test' })).toThrow(
        /AUTH_PROVIDER/,
      );
      expect(() => loadEnv({ ...production, ...s3, LABEL_QR_MIN_SIZE_MM: undefined })).toThrow(
        /LABEL_QR_MIN_SIZE_MM/,
      );
    });

    it.each([
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'S3_BUCKET',
      'S3_EXPECTED_BUCKET_OWNER',
    ] as const)('requires %s; never falls back to ambient credentials', (name) => {
      expect(() => loadEnv({ ...production, ...s3, [name]: '' })).toThrow(/S3 requires/);
    });

    it.each(['development', 'test'])('never connects %s to production S3', (APP_ENV) => {
      expect(() => loadEnv({ ...valid, ...s3, APP_ENV })).toThrow(
        /S3 storage is configured only in production/,
      );
    });

    it('refuses AWS configuration with local storage rather than silently ignoring it', () => {
      expect(() => loadEnv({ ...valid, AWS_REGION: 'eu-north-1' })).toThrow(
        /Do not supply S3 configuration/,
      );
      expect(
        loadEnv({
          ...valid,
          AWS_REGION: '',
          AWS_ACCESS_KEY_ID: '',
          AWS_SECRET_ACCESS_KEY: '',
          S3_BUCKET: '',
          S3_EXPECTED_BUCKET_OWNER: '',
        }).FILE_STORAGE_DRIVER,
      ).toBe('local');
    });

    it('rejects URLs as bucket names, invalid owner IDs and secret injection without echoing them', () => {
      const secret = 'private-value-must-not-be-printed\nAWS_REGION=other';
      expect(() => loadEnv({ ...production, ...s3, S3_BUCKET: 'https://other.example' })).toThrow(
        /S3_BUCKET/,
      );
      expect(() => loadEnv({ ...production, ...s3, S3_EXPECTED_BUCKET_OWNER: 'wrong' })).toThrow(
        /S3_EXPECTED_BUCKET_OWNER/,
      );
      try {
        loadEnv({ ...production, ...s3, AWS_SECRET_ACCESS_KEY: secret });
        expect.fail('invalid secret was accepted');
      } catch (error) {
        expect(String(error)).toContain('AWS_SECRET_ACCESS_KEY');
        expect(String(error)).not.toContain(secret);
      }
    });
  });

  describe('identity and access (ADR 0022)', () => {
    it('uses the real provider outside tests and the fake provider only in tests', () => {
      expect(loadEnv(valid)).toMatchObject({
        AUTH_PROVIDER: 'workos',
        APP_PUBLIC_ORIGIN: 'http://localhost:3000',
      });
      expect(
        loadEnv({ DATABASE_URL: valid.DATABASE_URL, REDIS_URL: valid.REDIS_URL, APP_ENV: 'test' }),
      ).toMatchObject({ AUTH_PROVIDER: 'test' });
    });

    it('never allows the fake carrier on DEV or production (doc 029: nothing pretended)', () => {
      expect(loadEnv(valid).CARRIER_PROVIDER).toBe('none');
      expect(() => loadEnv({ ...valid, CARRIER_PROVIDER: 'test' })).toThrow(
        /CARRIER_PROVIDER=test/,
      );
      expect(() => loadEnv({ ...production, CARRIER_PROVIDER: 'test' })).toThrow(
        /CARRIER_PROVIDER=test/,
      );
    });

    it('PPL TEST credentials: both or neither, fixed URL outside tests, never in production', () => {
      const creds = { PPL_TEST_CLIENT_ID: 'fake-id', PPL_TEST_CLIENT_SECRET: 'fake-secret' };
      expect(loadEnv({ ...valid, ...creds }).PPL_TEST_CLIENT_ID).toBe('fake-id');
      // Empty values from Compose mean "not set".
      expect(
        loadEnv({ ...valid, PPL_TEST_CLIENT_ID: '', PPL_TEST_CLIENT_SECRET: '' })
          .PPL_TEST_CLIENT_ID,
      ).toBeUndefined();
      expect(() => loadEnv({ ...valid, PPL_TEST_CLIENT_ID: 'fake-id' })).toThrow(/go together/);
      expect(() =>
        loadEnv({ ...valid, ...creds, PPL_TEST_API_BASE_URL_FOR_TESTS: 'http://127.0.0.1:1/x' }),
      ).toThrow(/APP_ENV=test/);
      expect(() => loadEnv({ ...production, ...creds })).toThrow(/not used in production/);
    });

    it('never allows the fake provider on DEV or production (no authentication bypass)', () => {
      expect(() => loadEnv({ ...valid, AUTH_PROVIDER: 'test' })).toThrow(/AUTH_PROVIDER=test/);
      expect(() => loadEnv({ ...production, AUTH_PROVIDER: 'test' })).toThrow(/AUTH_PROVIDER=test/);
    });

    it('refuses to start without WorkOS credentials, and never echoes secret values', () => {
      const withoutKey: Record<string, string> = { ...valid };
      delete withoutKey.WORKOS_API_KEY;
      expect(() => loadEnv(withoutKey)).toThrow(
        /WORKOS_API_KEY, WORKOS_CLIENT_ID and WORKOS_JWT_ISSUER/,
      );
      const secret = 'fake_secret_value_must_never_be_printed';
      let message = '';
      try {
        loadEnv({ ...valid, WORKOS_API_KEY: secret, SESSION_IDLE_MINUTES: '1' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/SESSION_IDLE_MINUTES/);
      expect(message).not.toContain(secret);
    });

    it('refuses development and production without the exact WorkOS token issuer', () => {
      for (const base of [valid, production]) {
        const withoutIssuer: Record<string, string> = { ...base };
        delete withoutIssuer.WORKOS_JWT_ISSUER;
        expect(() => loadEnv(withoutIssuer)).toThrow(/WORKOS_JWT_ISSUER/);
        expect(() => loadEnv({ ...base, WORKOS_JWT_ISSUER: '' })).toThrow(/WORKOS_JWT_ISSUER/);
        expect(() => loadEnv({ ...base, WORKOS_JWT_ISSUER: 'http://auth.example' })).toThrow(
          /WORKOS_JWT_ISSUER/,
        );
      }
    });

    it('requires APP_PUBLIC_ORIGIN in production and a sane session lifetime', () => {
      const noOrigin: Record<string, string> = { ...production };
      delete noOrigin.APP_PUBLIC_ORIGIN;
      expect(() =>
        loadEnv({
          ...noOrigin,
          WORKOS_API_KEY: valid.WORKOS_API_KEY,
          WORKOS_CLIENT_ID: valid.WORKOS_CLIENT_ID,
          WORKOS_JWT_ISSUER: valid.WORKOS_JWT_ISSUER,
        }),
      ).toThrow(/APP_PUBLIC_ORIGIN/);
      expect(() =>
        loadEnv({ ...valid, SESSION_IDLE_MINUTES: '600', SESSION_ABSOLUTE_HOURS: '2' }),
      ).toThrow(/idle timeout/);
    });

    it('session defaults are 120 minutes of inactivity and 12 hours absolute (owner decision)', () => {
      expect(loadEnv(valid)).toMatchObject({
        SESSION_IDLE_MINUTES: 120,
        SESSION_ABSOLUTE_HOURS: 12,
      });
    });
  });
});
