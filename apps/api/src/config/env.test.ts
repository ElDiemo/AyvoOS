import { describe, expect, it } from 'vitest';
import { labelQrSettings, loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_ENCRYPTION_KEY: '5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28', // synthetic test value
  AUTH_SMTP_HOST: 'smtp.example.test',
  AUTH_SMTP_USER: 'synthetic-smtp-user',
  AUTH_SMTP_PASSWORD: 'synthetic-smtp-password',
  AUTH_MAIL_FROM: 'noreply@ayvo.test',
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

  describe('QR label settings never stop the application (owner 2026-10-23)', () => {
    it('production without them fails only for what else is missing (here: file storage)', () => {
      for (const unset of [undefined, '', '  ']) {
        const source = {
          ...production,
          LABEL_QR_MIN_SIZE_MM: unset,
          LABEL_QR_ERROR_CORRECTION: unset,
        };
        expect(() => loadEnv(source)).toThrow(/Production file storage is not configured/);
        expect(() => loadEnv(source)).not.toThrow(/LABEL_QR/);
      }
    });

    it('production gets exactly what is configured, never the candidates 10 mm / Q', () => {
      expect(labelQrSettings('production', undefined, undefined)).toEqual({
        LABEL_QR_MIN_SIZE_MM: null,
        LABEL_QR_ERROR_CORRECTION: null,
      });
      expect(labelQrSettings('production', 15, undefined)).toEqual({
        LABEL_QR_MIN_SIZE_MM: 15,
        LABEL_QR_ERROR_CORRECTION: null,
      });
      expect(labelQrSettings('production', 15, 'H')).toEqual({
        LABEL_QR_MIN_SIZE_MM: 15,
        LABEL_QR_ERROR_CORRECTION: 'H',
      });
    });

    it('elsewhere an empty value (Compose `${VAR:-}`) is unset and gets the candidates', () => {
      expect(
        loadEnv({ ...valid, LABEL_QR_MIN_SIZE_MM: '', LABEL_QR_ERROR_CORRECTION: ' ' }),
      ).toMatchObject({ LABEL_QR_MIN_SIZE_MM: 10, LABEL_QR_ERROR_CORRECTION: 'Q' });
    });

    it('a malformed value is still a configuration error at startup', () => {
      expect(() => loadEnv({ ...valid, LABEL_QR_MIN_SIZE_MM: '2' })).toThrow(
        /LABEL_QR_MIN_SIZE_MM/,
      );
      expect(() => loadEnv({ ...valid, LABEL_QR_ERROR_CORRECTION: 'X' })).toThrow(
        /LABEL_QR_ERROR_CORRECTION/,
      );
    });
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
      // ADR 0034: the QR label settings are no start condition — production runs without them
      // (null: only our QR label operations are refused), and gets no candidate default.
      expect(
        loadEnv({
          ...production,
          ...s3,
          LABEL_QR_MIN_SIZE_MM: undefined,
          LABEL_QR_ERROR_CORRECTION: '',
        }),
      ).toMatchObject({ LABEL_QR_MIN_SIZE_MM: null, LABEL_QR_ERROR_CORRECTION: null });
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
    it('uses native authentication outside tests and a fixture provider only in tests', () => {
      expect(loadEnv(valid)).toMatchObject({
        AUTH_PROVIDER: 'local',
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

    it('refuses to start without a native key, and never echoes secret values', () => {
      const withoutKey: Record<string, string> = { ...valid };
      delete withoutKey.AUTH_ENCRYPTION_KEY;
      expect(() => loadEnv(withoutKey)).toThrow(/AUTH_ENCRYPTION_KEY/);
      // The automated-test default and typed patterns are refused outside tests.
      for (const weak of ['11'.repeat(32), '22'.repeat(32), '0123'.repeat(16), 'ab'.repeat(32)]) {
        expect(() => loadEnv({ ...valid, AUTH_ENCRYPTION_KEY: weak })).toThrow(/randomly/);
        expect(() => loadEnv({ ...production, AUTH_ENCRYPTION_KEY: weak })).toThrow(/randomly/);
      }
      const secret = 'fake_secret_value_must_never_be_printed';
      let message = '';
      try {
        loadEnv({ ...valid, AUTH_SMTP_PASSWORD: secret, SESSION_IDLE_MINUTES: '1' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/SESSION_IDLE_MINUTES/);
      expect(message).not.toContain(secret);
    });

    it('requires approved SMTP configuration and refuses memory delivery outside tests', () => {
      for (const base of [valid, production]) {
        expect(() => loadEnv({ ...base, AUTH_SMTP_HOST: '' })).toThrow(/SMTP/);
        expect(() => loadEnv({ ...base, AUTH_MAIL_DRIVER: 'memory' })).toThrow(/Memory mail/);
        expect(() => loadEnv({ ...base, AUTH_SMTP_PORT: '25' })).toThrow(/AUTH_SMTP_PORT/);
        expect(() => loadEnv({ ...base, AUTH_PROVIDER: 'workos' })).toThrow(/AUTH_PROVIDER/);
      }
    });

    it('google-relay is explicit, credential-free, needs the sender and refuses mixed settings', () => {
      const relay: Record<string, string> = {
        ...valid,
        AUTH_MAIL_DRIVER: 'google-relay',
        AUTH_SMTP_HOST: '',
        AUTH_SMTP_USER: '',
        AUTH_SMTP_PASSWORD: '',
      };
      // The same rules on DEV and production: nothing in the mail mode depends on APP_ENV.
      expect(loadEnv(relay).AUTH_MAIL_DRIVER).toBe('google-relay');
      expect(() => loadEnv({ ...relay, AUTH_MAIL_FROM: '' })).toThrow(/AUTH_MAIL_FROM/);
      for (const extra of ['AUTH_SMTP_HOST', 'AUTH_SMTP_USER', 'AUTH_SMTP_PASSWORD'])
        expect(() => loadEnv({ ...relay, [extra]: 'x' })).toThrow(/without credentials/);
      // Never implied: without the explicit driver, missing credentials stay an error.
      const implicit = { ...relay };
      delete implicit.AUTH_MAIL_DRIVER;
      expect(() => loadEnv(implicit)).toThrow(/SMTP host, credentials/);
    });

    it('requires APP_PUBLIC_ORIGIN in production and a sane session lifetime', () => {
      const noOrigin: Record<string, string> = { ...production };
      delete noOrigin.APP_PUBLIC_ORIGIN;
      expect(() =>
        loadEnv({
          ...noOrigin,
          AUTH_ENCRYPTION_KEY: valid.AUTH_ENCRYPTION_KEY,
          AUTH_SMTP_HOST: valid.AUTH_SMTP_HOST,
          AUTH_SMTP_USER: valid.AUTH_SMTP_USER,
          AUTH_SMTP_PASSWORD: valid.AUTH_SMTP_PASSWORD,
          AUTH_MAIL_FROM: valid.AUTH_MAIL_FROM,
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
