import 'server-only';
import { z } from 'zod';

const origin = z
  .url({ protocol: /^https?$/ })
  .refine((url) => new URL(url).origin === url, 'an origin without a path');

/**
 * portal-web's own server configuration (ADR 0045 §6): the internal URLs of the core and Finance,
 * its two tokens (one per receiver, never shared) and its own public origin. Server only: never
 * in the browser, logs or git.
 */
const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORTAL_PUBLIC_ORIGIN: origin,
    CORE_INTERNAL_URL: origin,
    FINANCE_INTERNAL_URL: origin,
    PORTAL_CORE_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    PORTAL_FINANCE_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    /** 1 = behind the portal's reverse proxy, whose X-Forwarded-For entry names the client. */
    PORTAL_TRUST_PROXY: z.enum(['0', '1']).default('0'),
    /** At most this many PDFs pass through at once (§8: as Finance's own limit). */
    PORTAL_PDF_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(8).default(2),
  })
  .refine((e) => e.PORTAL_PUBLIC_ORIGIN.startsWith('https://') || e.APP_ENV === 'test', {
    message: 'PORTAL_PUBLIC_ORIGIN must be https (http only in tests)',
    path: ['PORTAL_PUBLIC_ORIGIN'],
  })
  .refine((e) => e.PORTAL_CORE_TOKEN !== e.PORTAL_FINANCE_TOKEN, {
    message: 'the core and Finance tokens must differ',
    path: ['PORTAL_FINANCE_TOKEN'],
  });

export type PortalEnv = z.infer<typeof schema>;

let cached: PortalEnv | null = null;
/** Read when first needed (not at build time); a missing value fails the request, never guesses. */
export function portalEnv(): PortalEnv {
  cached ??= schema.parse(process.env);
  return cached;
}
