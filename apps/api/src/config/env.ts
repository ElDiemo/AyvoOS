import { z } from 'zod';
import { qrBaseUrlViolation } from '../common/qr-policy.js';

const QR_ERROR_CORRECTION_LEVELS = ['L', 'M', 'Q', 'H'] as const;

/** Validated runtime configuration. Fails fast on startup if anything is missing or malformed. */
export const envSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    // Base of every public bottle QR URL: `${PUBLIC_QR_BASE_URL}/${publicToken}` (ADR 0014).
    // DEV preview: https://dev.ayvo.co/q. Production must set it (and only the production QR
    // host is accepted there); other environments must never use the production QR host.
    PUBLIC_QR_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .refine((url) => !url.endsWith('/'), 'PUBLIC_QR_BASE_URL must not end with a slash')
      .refine((url) => !/[?#]/.test(url), 'PUBLIC_QR_BASE_URL must not contain a query or fragment')
      .refine((url) => {
        const parsed = new URL(url);
        return parsed.username === '' && parsed.password === '';
      }, 'PUBLIC_QR_BASE_URL must not contain credentials')
      .optional(),

    // File storage (ADR 0016). `local` is DEV-only: production refuses to start with it until
    // an object-storage implementation exists.
    FILE_STORAGE_DRIVER: z.enum(['local']).default('local'),
    // Root of the local file storage. Relative paths resolve against the working directory
    // (`apps/api` under `pnpm dev`, like the .env lookup).
    FILE_STORAGE_DIR: z.string().min(1).default('../../var/storage'),

    // QR print settings — PROVISIONAL until the physical print/scan test (doc 016, ADR 0014).
    // Production must set both explicitly; other environments default to the current candidate
    // error correction (Q) and allow 10 mm so the validation sheet sizes can be tried.
    LABEL_QR_MIN_SIZE_MM: z.coerce.number().min(5).max(100).optional(),
    LABEL_QR_ERROR_CORRECTION: z.enum(QR_ERROR_CORRECTION_LEVELS).optional(),

    // Workstation session lease (doc 026): inactivity after which another authorized user may
    // take the station over (never automatic). Configuration, not a code constant (doc 020 §6).
    STATION_SESSION_LEASE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),

    // Upper limit for uploaded label artwork, in bytes.
    LABEL_ARTWORK_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),

    // --- Identity and access (ADR 0022, doc 021) ---------------------------------------------
    // Origin of the web application as the browser sees it (redirect URIs, Origin checks of
    // state-changing requests). DEV preview: https://dev.ayvo.co. Required in production.
    APP_PUBLIC_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .refine((url) => new URL(url).pathname === '/' && !url.endsWith('/'), 'origin without path')
      .optional(),
    // `workos` everywhere except automated tests; `test` (a fake provider) only with APP_ENV=test.
    AUTH_PROVIDER: z.enum(['workos', 'test']).optional(),
    WORKOS_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(10).optional()),
    WORKOS_CLIENT_ID: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(10).optional(),
    ),
    WORKOS_API_BASE_URL: z.url({ protocol: /^https$/ }).default('https://api.workos.com'),
    // Exact expected `iss` of WorkOS access tokens (copied from the WorkOS dashboard / a decoded
    // token; custom auth domains change it). Required whenever AUTH_PROVIDER=workos; never derived
    // from a token.
    WORKOS_JWT_ISSUER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url({ protocol: /^https$/ }).optional(),
    ),
    // Rate limiting of the sign-in routes (Redis, per client IP, fixed window; doc 021 §5b).
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
    AUTH_RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).max(100_000).default(30),
    AUTH_RATE_LIMIT_CALLBACK_MAX: z.coerce.number().int().min(1).max(100_000).default(30),
    AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: z.coerce.number().int().min(1).max(100_000).default(10),
    // Proxies (IPs or CIDRs, comma-separated) whose X-Forwarded-For names the client. Empty: the
    // socket address is the client. DEV: the Docker networks Caddy reaches the API from.
    TRUSTED_PROXY_CIDRS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      )
      .pipe(
        z.array(
          z
            .string()
            .regex(
              /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/(?:[0-9]|[12]\d|3[0-2]))?|[0-9a-fA-F:]+(?:\/(?:\d|[1-9]\d|1[01]\d|12[0-8]))?)$/,
              'an IPv4/IPv6 address or CIDR',
            ),
        ),
      ),

    // Application session lifetime: idle timeout and absolute maximum.
    SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(120),
    SESSION_ABSOLUTE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(7 * 24)
      .default(12),

    // Carrier for shipping labels (doc 029). `none` until a real carrier adapter is configured
    // (PPL needs owner-provided test access); `test` — a fake carrier — only with APP_ENV=test.
    CARRIER_PROVIDER: z.enum(['none', 'test']).default('none'),
    // Every carrier call is abandoned (outcome unknown, never re-sent) after this time.
    CARRIER_CALL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(30),
    // Pause between batch status reads while waiting for PPL's changed labels after a format change
    // (doc 030 §2; new data GUIDs appeared after ≈2 s in the TEST environment).
    CARRIER_LABEL_VARIANT_WAIT_MS: z.coerce.number().int().min(0).max(10000).default(1500),
    // Expired print job leases are ended this often (doc 030 §4); 0 = off (tests drive it).
    PRINT_SWEEP_SECONDS: z.coerce.number().int().min(0).max(3600).default(15),
    // A request claimed for sending is treated as possibly in flight for this long: no lookup and
    // no manual resolution before (doc 029 §3). Outside tests at least 3 × the call timeout.
    CARRIER_SETTLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
    // PPL CPL API — TEST environment only (doc 029 §9). Credentials come from the server's protected
    // env file, never from the repository, the database or the browser. No production connection
    // exists in this stage; the base URL is fixed in code (not configurable by users).
    PPL_TEST_CLIENT_ID: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).max(200).optional(),
    ),
    PPL_TEST_CLIENT_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).max(500).optional(),
    ),
    // AES-256-GCM key (base64, 32 bytes) for carrier credentials entered in the administration
    // (ADR 0027). Without it, credentials cannot be entered or read there.
    CARRIER_CREDENTIALS_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .refine((v) => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32, {
          message: 'must be 32 random bytes in base64',
        })
        .optional(),
    ),
    // Only for automated tests (a simulated PPL server); refused unless APP_ENV=test.
    PPL_TEST_API_BASE_URL_FOR_TESTS: z.url({ protocol: /^https?$/ }).optional(),

    // Background polling of accepted carrier requests (seconds between rounds; 0 = off).
    CARRIER_POLL_SECONDS: z.coerce.number().int().min(0).max(3600).default(10),
    // Automatic tracking (doc 031): seconds between two looks at one shipment (failures back off
    // from it, up to 6 h). Runs in the same background rounds as the polling above.
    CARRIER_TRACKING_SECONDS: z.coerce.number().int().min(10).max(86400).default(900),
    // Supply plans (doc 032): seconds between two rounds creating the orders of switched-on plans
    // (same in-process infrastructure as the carrier polling; 0 = off, tests drive it).
    SUPPLY_PLAN_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),

    // Upper limit for an uploaded supplier document (PDF, JPEG or PNG), in bytes.
    SUPPLIER_DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),
  })
  .transform((env, ctx) => {
    const production = env.APP_ENV === 'production';
    const fail = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
      return z.NEVER;
    };

    // Identity first: a misconfigured authentication must never be masked by another error.
    const authProvider = env.AUTH_PROVIDER ?? (env.APP_ENV === 'test' ? 'test' : 'workos');
    if (authProvider === 'test' && env.APP_ENV !== 'test') {
      // Never a bypass on DEV or production: the fake provider exists for automated tests only.
      return fail('AUTH_PROVIDER', 'AUTH_PROVIDER=test is allowed only with APP_ENV=test');
    }
    if (
      authProvider === 'workos' &&
      (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID || !env.WORKOS_JWT_ISSUER)
    ) {
      return fail(
        'AUTH_PROVIDER',
        'WORKOS_API_KEY, WORKOS_CLIENT_ID and WORKOS_JWT_ISSUER are required for AUTH_PROVIDER=workos',
      );
    }
    if (env.CARRIER_PROVIDER === 'test' && env.APP_ENV !== 'test') {
      // Never a pretended carrier on DEV or production: no fake labels, numbers or answers.
      return fail('CARRIER_PROVIDER', 'CARRIER_PROVIDER=test is allowed only with APP_ENV=test');
    }
    if (env.PPL_TEST_API_BASE_URL_FOR_TESTS && env.APP_ENV !== 'test') {
      return fail('PPL_TEST_API_BASE_URL_FOR_TESTS', 'allowed only with APP_ENV=test');
    }
    if (env.APP_ENV === 'production' && env.PPL_TEST_CLIENT_ID) {
      return fail('PPL_TEST_CLIENT_ID', 'the PPL TEST connection is not used in production');
    }
    if (!!env.PPL_TEST_CLIENT_ID !== !!env.PPL_TEST_CLIENT_SECRET) {
      return fail(
        'PPL_TEST_CLIENT_ID',
        'PPL_TEST_CLIENT_ID and PPL_TEST_CLIENT_SECRET go together',
      );
    }
    if (
      env.APP_ENV !== 'test' &&
      env.CARRIER_SETTLE_SECONDS < 3 * env.CARRIER_CALL_TIMEOUT_SECONDS
    ) {
      return fail(
        'CARRIER_SETTLE_SECONDS',
        'CARRIER_SETTLE_SECONDS must be at least 3 × CARRIER_CALL_TIMEOUT_SECONDS',
      );
    }
    if (production && !env.APP_PUBLIC_ORIGIN) {
      return fail('APP_PUBLIC_ORIGIN', 'APP_PUBLIC_ORIGIN is required in production');
    }
    if (env.SESSION_IDLE_MINUTES > env.SESSION_ABSOLUTE_HOURS * 60) {
      return fail(
        'SESSION_IDLE_MINUTES',
        'The idle timeout cannot exceed the absolute session lifetime',
      );
    }

    if (production && !env.PUBLIC_QR_BASE_URL) {
      return fail('PUBLIC_QR_BASE_URL', 'PUBLIC_QR_BASE_URL is required in production');
    }
    const publicQrBaseUrl = env.PUBLIC_QR_BASE_URL ?? 'http://localhost:3000/q';
    const violation = qrBaseUrlViolation(env.APP_ENV, publicQrBaseUrl);
    if (violation) return fail('PUBLIC_QR_BASE_URL', violation);

    if (production && env.LABEL_QR_MIN_SIZE_MM === undefined) {
      return fail(
        'LABEL_QR_MIN_SIZE_MM',
        'Set the physically validated QR minimum size in production',
      );
    }
    if (production && env.LABEL_QR_ERROR_CORRECTION === undefined) {
      return fail(
        'LABEL_QR_ERROR_CORRECTION',
        'Set the physically validated QR error correction in production',
      );
    }
    if (production && env.FILE_STORAGE_DRIVER === 'local') {
      return fail(
        'FILE_STORAGE_DRIVER',
        'Production file storage is not configured: local storage is DEV-only (ADR 0016)',
      );
    }

    return {
      ...env,
      AUTH_PROVIDER: authProvider,
      APP_PUBLIC_ORIGIN: env.APP_PUBLIC_ORIGIN ?? 'http://localhost:3000',
      PUBLIC_QR_BASE_URL: publicQrBaseUrl,
      LABEL_QR_MIN_SIZE_MM: env.LABEL_QR_MIN_SIZE_MM ?? 10,
      LABEL_QR_ERROR_CORRECTION: env.LABEL_QR_ERROR_CORRECTION ?? ('Q' as const),
    };
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
