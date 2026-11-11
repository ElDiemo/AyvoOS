import 'server-only';
import { PORTAL_PACKAGE_MAX_MS, PORTAL_PACKAGE_PORTAL_GRACE_MS } from '@ayvo/types';
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
    /**
     * Invoice packages in transfer at once in this process (their own slots — a package never
     * takes a PDF's), and at most one per portal account (review of #178, #169 sprint). A package
     * holds its slot until its body has been pulled into the connection or the transfer is cut.
     */
    PORTAL_PACKAGE_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(4).default(2),
    /**
     * A package's slot is held at least as long as its size takes at this rate (B/s), even when its
     * bytes left portal-web sooner — buffers between here and the browser (kernel, proxies, the
     * edge) can take most of a package at once, so "pulled" is not "delivered". Default: A1's
     * design rate, 8 Mbit/s (16 MiB ≈ 17 s, doc 064 §2). Measured in portal-a1-acceptance.
     */
    PORTAL_PACKAGE_HOLD_RATE_BPS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(100_000_000)
      .default(1_000_000),
    /**
     * One deadline for the invoice package (fetch, transfer, answer). Behind an edge with a write
     * limit it must end below that limit (PROD's public edge: 30 s → 25 s, doc 064 §2); never
     * longer than Finance's ceiling plus the grace.
     */
    PORTAL_PACKAGE_DEADLINE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(PORTAL_PACKAGE_MAX_MS + PORTAL_PACKAGE_PORTAL_GRACE_MS)
      .default(PORTAL_PACKAGE_MAX_MS + PORTAL_PACKAGE_PORTAL_GRACE_MS),
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
