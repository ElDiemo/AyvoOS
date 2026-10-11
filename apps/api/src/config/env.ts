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

    // Upper limit for uploaded label artwork, in bytes.
    LABEL_ARTWORK_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),

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
