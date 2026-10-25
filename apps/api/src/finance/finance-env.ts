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
  })
  .superRefine((env, ctx) => {
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
