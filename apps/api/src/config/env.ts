import { z } from 'zod';
import { qrBaseUrlViolation } from '../common/qr-policy.js';

const QR_ERROR_CORRECTION_LEVELS = ['L', 'M', 'Q', 'H'] as const;

/**
 * The QR print settings as the application uses them. Production: exactly what is configured,
 * never a candidate default (null = not set; only our QR label operations are then refused).
 * Elsewhere unset values default to the provisional candidates 10 mm / Q.
 */
export function labelQrSettings(
  appEnv: 'development' | 'test' | 'production',
  minSizeMm: number | undefined,
  errorCorrection: (typeof QR_ERROR_CORRECTION_LEVELS)[number] | undefined,
) {
  const production = appEnv === 'production';
  return {
    LABEL_QR_MIN_SIZE_MM: minSizeMm ?? (production ? null : 10),
    LABEL_QR_ERROR_CORRECTION: errorCorrection ?? (production ? null : ('Q' as const)),
  };
}

/** An empty or whitespace-only variable counts as not set. */
const blankAsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

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

    // ADR 0016 / 0032: local stays DEV-only. S3 is explicitly configured on production only;
    // never pick it implicitly just because AWS credentials happen to exist in the process.
    FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    // Root of the local file storage. Relative paths resolve against the working directory
    // (`apps/api` under `pnpm dev`, like the .env lookup).
    FILE_STORAGE_DIR: z.string().min(1).default('../../var/storage'),
    AWS_REGION: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/)
        .optional(),
    ),
    // Explicit credentials only: no ambient profile, EC2 metadata or shared credentials fallback.
    AWS_ACCESS_KEY_ID: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .min(16)
        .max(128)
        .regex(/^[A-Z0-9]+$/)
        .optional(),
    ),
    AWS_SECRET_ACCESS_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9/+=]+$/)
        .optional(),
    ),
    // General-purpose AWS bucket name without dots (virtual-hosted TLS); no URL/ARN/endpoints.
    S3_BUCKET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
        .optional(),
    ),
    S3_EXPECTED_BUCKET_OWNER: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^\d{12}$/)
        .optional(),
    ),

    // QR print settings — PROVISIONAL until the physical print/scan test (doc 016, ADR 0014).
    // Other environments default to the current candidate error correction (Q) and allow 10 mm
    // so the validation sheet sizes can be tried. Production has NO default: without both values
    // the application runs, and only the operations that create or print our QR labels are
    // refused (qr-label-settings.ts). An empty value (e.g. `${VAR:-}` in Compose) is "not set".
    LABEL_QR_MIN_SIZE_MM: z.preprocess(blankAsUnset, z.coerce.number().min(5).max(100).optional()),
    LABEL_QR_ERROR_CORRECTION: z.preprocess(
      blankAsUnset,
      z.enum(QR_ERROR_CORRECTION_LEVELS).optional(),
    ),

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
    // Local authentication everywhere; the legacy fixture provider exists only in tests.
    AUTH_PROVIDER: z.enum(['local', 'test']).optional(),
    AUTH_ENCRYPTION_KEY: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    ),
    // `smtp` = authenticated submission; `google-relay` = the approved Google Workspace relay that
    // authorises AYVO's public IPv4 addresses (no credentials, fixed host, TLS required).
    AUTH_MAIL_DRIVER: z.enum(['smtp', 'google-relay', 'memory']).optional(),
    AUTH_SMTP_HOST: z.preprocess(blankAsUnset, z.string().min(1).max(253).optional()),
    AUTH_SMTP_PORT: z.coerce
      .number()
      .pipe(z.union([z.literal(465), z.literal(587)]))
      .default(465),
    AUTH_SMTP_USER: z.preprocess(blankAsUnset, z.string().min(1).max(254).optional()),
    AUTH_SMTP_PASSWORD: z.preprocess(blankAsUnset, z.string().min(1).max(1024).optional()),
    AUTH_MAIL_FROM: z.preprocess(blankAsUnset, z.email().optional()),
    // Rate limiting of the sign-in routes (Redis, per client IP, fixed window; doc 021 §5b).
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
    AUTH_RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).max(100_000).default(30),
    AUTH_RATE_LIMIT_CALLBACK_MAX: z.coerce.number().int().min(1).max(100_000).default(30),
    AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: z.coerce.number().int().min(1).max(100_000).default(10),
    // Rate limit of the anonymous public routes (/api/public/*: QR passports), per client IP in
    // Redis, fixed window. Behind the public QR edge the client is the visitor, never the web
    // server (the web forwards the edge's X-Forwarded-For; doc 037).
    PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(120),
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
    const authProvider = env.AUTH_PROVIDER ?? (env.APP_ENV === 'test' ? 'test' : 'local');
    if (authProvider === 'test' && env.APP_ENV !== 'test') {
      // Never a bypass on DEV or production: the fake provider exists for automated tests only.
      return fail('AUTH_PROVIDER', 'AUTH_PROVIDER=test is allowed only with APP_ENV=test');
    }
    const mailDriver = env.AUTH_MAIL_DRIVER ?? (env.APP_ENV === 'test' ? 'memory' : 'smtp');
    if (mailDriver === 'memory' && env.APP_ENV !== 'test')
      return fail('AUTH_MAIL_DRIVER', 'Memory mail delivery is allowed only in automated tests');
    if (env.APP_ENV !== 'test' && !env.AUTH_ENCRYPTION_KEY)
      return fail(
        'AUTH_ENCRYPTION_KEY',
        'A separate 32-byte native authentication key is required',
      );
    // A generated key (openssl rand -hex 32) has ~16 distinct hex digits; test keys like `11…`
    // or a typed pattern have few. Only the value's shape is judged, never echoed.
    if (env.APP_ENV !== 'test' && new Set(env.AUTH_ENCRYPTION_KEY!.toLowerCase()).size < 10)
      return fail('AUTH_ENCRYPTION_KEY', 'Generate the key randomly (openssl rand -hex 32)');
    if (
      mailDriver === 'smtp' &&
      (!env.AUTH_SMTP_HOST || !env.AUTH_SMTP_USER || !env.AUTH_SMTP_PASSWORD || !env.AUTH_MAIL_FROM)
    )
      return fail('AUTH_MAIL_DRIVER', 'Configure approved SMTP host, credentials and sender');
    if (mailDriver === 'google-relay') {
      // Explicit only: credentials or another host next to it would make the mode ambiguous.
      if (env.AUTH_SMTP_HOST || env.AUTH_SMTP_USER || env.AUTH_SMTP_PASSWORD)
        return fail(
          'AUTH_MAIL_DRIVER',
          'google-relay uses the fixed Google relay without credentials; remove AUTH_SMTP_HOST/USER/PASSWORD',
        );
      if (!env.AUTH_MAIL_FROM)
        return fail('AUTH_MAIL_FROM', 'google-relay needs the approved sender address');
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

    if (production && env.FILE_STORAGE_DRIVER === 'local') {
      return fail(
        'FILE_STORAGE_DRIVER',
        'Production file storage is not configured: local storage is DEV-only (ADR 0016)',
      );
    }
    if (env.FILE_STORAGE_DRIVER === 's3') {
      if (!production) {
        return fail('FILE_STORAGE_DRIVER', 'S3 storage is configured only in production');
      }
      if (
        !env.AWS_REGION ||
        !env.AWS_ACCESS_KEY_ID ||
        !env.AWS_SECRET_ACCESS_KEY ||
        !env.S3_BUCKET ||
        !env.S3_EXPECTED_BUCKET_OWNER
      ) {
        return fail(
          'FILE_STORAGE_DRIVER',
          'S3 requires AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET and S3_EXPECTED_BUCKET_OWNER',
        );
      }
    } else if (
      env.AWS_REGION ||
      env.AWS_ACCESS_KEY_ID ||
      env.AWS_SECRET_ACCESS_KEY ||
      env.S3_BUCKET ||
      env.S3_EXPECTED_BUCKET_OWNER
    ) {
      return fail('FILE_STORAGE_DRIVER', 'Do not supply S3 configuration to local storage');
    }

    return {
      ...env,
      AUTH_PROVIDER: authProvider,
      AUTH_ENCRYPTION_KEY: env.AUTH_ENCRYPTION_KEY ?? '11'.repeat(32), // APP_ENV=test only above.
      AUTH_MAIL_DRIVER: mailDriver,
      AUTH_MAIL_FROM: env.AUTH_MAIL_FROM ?? 'noreply@ayvo.test',
      APP_PUBLIC_ORIGIN: env.APP_PUBLIC_ORIGIN ?? 'http://localhost:3000',
      PUBLIC_QR_BASE_URL: publicQrBaseUrl,
      ...labelQrSettings(env.APP_ENV, env.LABEL_QR_MIN_SIZE_MM, env.LABEL_QR_ERROR_CORRECTION),
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
