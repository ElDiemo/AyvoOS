import { z } from 'zod';

/**
 * Environment of the Finance unit (ADR 0039) — its own, small: no core secrets (no sign-in,
 * carrier, mail or auth keys). Its database URL is the runtime role `ayvo_finance` (schema
 * `finance` only); the core is reached only through CORE_INTERNAL_URL with the service token.
 */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

export const financeEnvSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    FINANCE_PORT: z.coerce.number().int().min(1).max(65535).default(4010),
    FINANCE_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** The core API inside the private network, e.g. http://api:4000 (never a public URL). */
    CORE_INTERNAL_URL: z.url({ protocol: /^https?$/ }),
    /** 32+ random bytes, base64url; the core holds only its SHA-256. */
    FINANCE_SERVICE_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    /** Contract timeouts (ADR 0039 §4). */
    CORE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    CORE_CONTENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    FILE_STORAGE_DIR: z.string().min(1).default('../../var/storage'),
    AWS_REGION: optional(z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/)),
    AWS_ACCESS_KEY_ID: optional(
      z
        .string()
        .min(16)
        .max(128)
        .regex(/^[A-Z0-9]+$/),
    ),
    AWS_SECRET_ACCESS_KEY: optional(
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9/+=]+$/),
    ),
    S3_BUCKET: optional(z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)),
    S3_EXPECTED_BUCKET_OWNER: optional(z.string().regex(/^\d{12}$/)),
    /** One upload (the same bound as supplier documents in the core). */
    FINANCE_DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),

    // --- Raiffeisenbank Premium API, read only (N3B-1, doc 041) ---------------------------------
    /**
     * Unset = no bank connection in this installation. `production` only with APP_ENV=production
     * (and nothing else there); `sandbox` = the bank's mock (development/test); `simulation` = the
     * DEV bank simulation (`rb-simulation` in the DEV Compose project, APP_ENV=development or test)
     * reached exactly like the bank — mTLS, client ID, read-only mounted files — with its own CA;
     * `test` = a local simulation (APP_ENV=test only). The URLs are fixed in code.
     */
    RB_PREMIUM_ENVIRONMENT: optional(z.enum(['production', 'sandbox', 'simulation', 'test'])),
    /** Paths to files mounted read-only for the Finance process — never the values in the env. */
    RB_PREMIUM_CLIENT_ID_FILE: optional(z.string().min(1)),
    RB_PREMIUM_P12_FILE: optional(z.string().min(1)),
    RB_PREMIUM_P12_PASSPHRASE_FILE: optional(z.string().min(1)),
    /**
     * The simulation's own CA (its server certificate is verified against it, hostname included)
     * — required with `simulation`, refused with the real bank (the system's trusted CAs only).
     */
    RB_PREMIUM_SIMULATION_CA_FILE: optional(z.string().min(1)),
    /** Accounts read: "number:CUR" (national number without prefix or bank code), comma-separated. */
    RB_PREMIUM_ACCOUNTS: optional(
      z.string().regex(/^[0-9]{1,10}:[A-Z]{3}(,[0-9]{1,10}:[A-Z]{3}){0,9}$/, 'e.g. 1234567890:CZK'),
    ),
    /** One request to the bank (connect + answer). */
    RB_PREMIUM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    /**
     * One run (one account × currency): all its requests, pauses and retries end by this deadline
     * — well inside the slot lease (10 min) together with storing (≤ 2 min), so a live run is
     * never taken over (review N3B75-R2).
     */
    RB_PREMIUM_RUN_DEADLINE_MS: z.coerce.number().int().min(1_000).max(360_000).default(300_000),
    /**
     * What one run may hold in memory before storing (review N3B75-R1): the answers' bytes
     * together and the number of entries. Exceeded → FAILED TOO_MUCH_DATA, nothing stored.
     */
    RB_PREMIUM_MAX_WINDOW_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(64 * 1024 * 1024)
      .default(32 * 1024 * 1024),
    RB_PREMIUM_MAX_WINDOW_ENTRIES: z.coerce.number().int().min(1).max(50_000).default(20_000),
    /** Pause before the first retry (429 / 5xx / network); the second waits twice as long. */
    RB_PREMIUM_RETRY_BASE_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
    // Only for automated tests (a simulated bank with its own CA); refused unless APP_ENV=test.
    RB_PREMIUM_BASE_URL_FOR_TESTS: optional(z.url({ protocol: /^https$/ })),
    RB_PREMIUM_CA_FILE_FOR_TESTS: optional(z.string().min(1)),
    /**
     * Only for automated tests of the `simulation` path: "host:port" to connect to instead of
     * resolving `rb-simulation` — the certificate is still verified for `rb-simulation`.
     */
    RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS: optional(
      z.string().regex(/^(127\.0\.0\.1|localhost):\d{1,5}$/),
    ),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const rb = env.RB_PREMIUM_ENVIRONMENT;
    if (rb === 'production' && env.APP_ENV !== 'production')
      fail('RB_PREMIUM_ENVIRONMENT', 'the production bank connection exists only in production');
    if (env.APP_ENV === 'production' && rb !== undefined && rb !== 'production')
      fail('RB_PREMIUM_ENVIRONMENT', 'production reads only the production bank');
    if (rb === 'test' && env.APP_ENV !== 'test')
      fail('RB_PREMIUM_ENVIRONMENT', 'the simulated bank is allowed only with APP_ENV=test');
    if (rb === 'simulation' && env.APP_ENV === 'production')
      fail('RB_PREMIUM_ENVIRONMENT', 'the bank simulation exists only on DEV');
    if (rb === 'simulation' && !env.RB_PREMIUM_SIMULATION_CA_FILE)
      fail('RB_PREMIUM_SIMULATION_CA_FILE', 'required with the simulation (its own CA)');
    if (rb !== 'simulation' && env.RB_PREMIUM_SIMULATION_CA_FILE)
      fail(
        'RB_PREMIUM_SIMULATION_CA_FILE',
        'only with the simulation: the bank is verified by the system CAs',
      );
    if (env.APP_ENV !== 'test') {
      if (env.RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS)
        fail('RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS', 'allowed only with APP_ENV=test');
      if (env.RB_PREMIUM_BASE_URL_FOR_TESTS)
        fail('RB_PREMIUM_BASE_URL_FOR_TESTS', 'allowed only with APP_ENV=test');
      if (env.RB_PREMIUM_CA_FILE_FOR_TESTS)
        fail('RB_PREMIUM_CA_FILE_FOR_TESTS', 'allowed only with APP_ENV=test');
    }
    if (rb === 'test' && !env.RB_PREMIUM_BASE_URL_FOR_TESTS)
      fail('RB_PREMIUM_BASE_URL_FOR_TESTS', 'the simulated bank needs its URL');
    if (rb !== undefined)
      for (const key of [
        'RB_PREMIUM_CLIENT_ID_FILE',
        'RB_PREMIUM_P12_FILE',
        'RB_PREMIUM_P12_PASSPHRASE_FILE',
        'RB_PREMIUM_ACCOUNTS',
      ] as const)
        if (!env[key]) fail(key, 'required with RB_PREMIUM_ENVIRONMENT');
    if (env.APP_ENV === 'production' && env.FILE_STORAGE_DRIVER !== 's3')
      ctx.addIssue({
        code: 'custom',
        path: ['FILE_STORAGE_DRIVER'],
        message: 'production Finance stores originals in S3 only (ADR 0016)',
      });
    if (env.APP_ENV === 'production' && new URL(env.CORE_INTERNAL_URL).protocol === 'https:')
      return;
  });

export type FinanceEnv = z.infer<typeof financeEnvSchema>;
export const FINANCE_ENV = Symbol('FINANCE_ENV');

export function loadFinanceEnv(source: NodeJS.ProcessEnv = process.env): FinanceEnv {
  const parsed = financeEnvSchema.safeParse(source);
  if (!parsed.success) {
    // Names only, never values (secrets).
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid Finance environment: ${fields}`);
  }
  return parsed.data;
}
