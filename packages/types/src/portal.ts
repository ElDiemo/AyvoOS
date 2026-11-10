import { z } from 'zod';
import { hotelProfileFieldsSchema } from './hotels.js';

/**
 * The core's hotel portal contract (ADR 0045 §3, §6): called only by portal-web's server side with
 * its own token, under /api/internal/v1/portal/. The browser never sees the core. portal-web holds
 * the cookies (`__Host-ayvo_portal`, `__Host-ayvo_portal_pre`) and forwards their values; the core
 * answers with tokens that portal-web puts into those cookies.
 */

export const PORTAL_SESSION_HEADER = 'x-ayvo-portal-session';

/** The browser request portal-web serves: for rate limits and the core's own CSRF check. */
export const portalClientSchema = z.strictObject({
  ip: z.union([z.ipv4(), z.ipv6()]),
  /** The browser's Origin header (must be the portal origin). */
  origin: z.string().max(2048),
  /** The browser's Sec-Fetch-Site header, if it sent one. */
  secFetchSite: z.string().max(32).nullable(),
});
export type PortalClient = z.infer<typeof portalClientSchema>;

const password = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => new TextEncoder().encode(v).length <= 1024);
const newPassword = password.refine((v) => [...v].length >= 12);
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const linkToken = z.string().length(43);
const preToken = z.string().min(1).max(128);

export const portalPasswordRequestSchema = z.strictObject({
  email,
  password,
  client: portalClientSchema,
});
export const portalActionRequestSchema = z.strictObject({
  token: linkToken,
  password: newPassword,
  client: portalClientSchema,
});
export const portalMfaRequestSchema = z.strictObject({
  /** The pre-session token from `__Host-ayvo_portal_pre`. */
  challenge: preToken,
  code: z.string().min(1).max(64),
  client: portalClientSchema,
});
export const portalForgotRequestSchema = z.strictObject({ email, client: portalClientSchema });
export const portalLogoutRequestSchema = z.strictObject({ client: portalClientSchema });
export type PortalPasswordRequest = z.infer<typeof portalPasswordRequestSchema>;
export type PortalActionRequest = z.infer<typeof portalActionRequestSchema>;
export type PortalMfaRequest = z.infer<typeof portalMfaRequestSchema>;
export type PortalForgotRequest = z.infer<typeof portalForgotRequestSchema>;
export type PortalLogoutRequest = z.infer<typeof portalLogoutRequestSchema>;

/** A pre-session step: portal-web stores `challenge` in `__Host-ayvo_portal_pre` for `maxAgeSeconds`. */
export const portalChallengeStepSchema = z.object({
  step: z.enum(['MFA', 'ENROLL_MFA']),
  challenge: z.string().min(1).max(128),
  maxAgeSeconds: z.number().int().positive(),
  /** Only for ENROLL_MFA. */
  qrDataUrl: z.string().startsWith('data:image/png;base64,').optional(),
  setupKey: z.string().optional(),
});
export type PortalChallengeStep = z.infer<typeof portalChallengeStepSchema>;

/** The MFA step's result: a portal session (into `__Host-ayvo_portal`) or a finished reset. */
export const portalMfaResultSchema = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('DONE'),
    session: z.string().min(1),
    maxAgeSeconds: z.number().positive(),
    recoveryCodes: z.array(z.string()).optional(),
  }),
  z.object({ step: z.literal('PASSWORD_RESET') }),
]);
export type PortalMfaResult = z.infer<typeof portalMfaResultSchema>;

/** The current portal session and what it may see right now (evaluated on every call). */
export const portalSessionViewSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
  grants: z.array(
    z.object({ id: z.uuid(), payerCustomerId: z.uuid(), hotelIds: z.array(z.uuid()) }),
  ),
});
export type PortalSessionView = z.infer<typeof portalSessionViewSchema>;

/** "Moje hotely": a granted hotel, read only (identity and address). */
export const portalHotelSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
});
export type PortalHotel = z.infer<typeof portalHotelSchema>;

/**
 * "Profil hotelu": a granted hotel's own profile. The name and country are shown, not edited; the
 * fingerprint names exactly these values, so a save made against older values is refused
 * (PROFILE_STALE) instead of silently overwriting someone else's change.
 */
export const portalHotelProfileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  countryCode: z.string(),
  address: z.object({
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    postalCode: z.string(),
    city: z.string(),
  }),
  contact: z.object({ name: z.string(), phone: z.string(), email: z.string() }),
  receiving: z.object({
    contactName: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
    deliveryNote: z.string().nullable(),
  }),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PortalHotelProfile = z.infer<typeof portalHotelProfileSchema>;

/**
 * "Smlouvy": a signed original of a contract for a granted hotel — only documents signed and
 * uploaded by AYVO (never a draft, a revision without a signed original, or the working template).
 * The PDF is downloaded as kept (its hash checked).
 */
export const portalContractSchema = z.object({
  id: z.uuid(),
  signedOn: z.iso.date(),
  /** The start of the service the signed revision names. */
  startOn: z.iso.date(),
  byteSize: z.int().min(1),
});
export type PortalContract = z.infer<typeof portalContractSchema>;

/** The browser → portal-web body of a profile save (whitelisted fields only). */
export const portalHotelProfileUpdateSchema = z.strictObject({
  expected: z.string().regex(/^[0-9a-f]{64}$/),
  profile: hotelProfileFieldsSchema,
  /** Why the hotel changes its details (owner 2026-11-09: required, kept in the audit). */
  reason: z.string().trim().min(3).max(500),
});
export type PortalHotelProfileUpdate = z.infer<typeof portalHotelProfileUpdateSchema>;

/** portal-web → core: the same, with the browser request the core checks again (CSRF). */
export const portalHotelProfileRequestSchema = portalHotelProfileUpdateSchema.extend({
  client: portalClientSchema,
});
export type PortalHotelProfileRequest = z.infer<typeof portalHotelProfileRequestSchema>;

// --- Finance ↔ core: introspection of a portal session (ADR 0045 §5, §6) ------------------------

/** What a PORTAL session may see now — its active grants (an empty list: nothing). */
export const portalIntrospectionSchema = z.object({
  userId: z.uuid(),
  grants: z.array(
    z.object({ id: z.uuid(), payerCustomerId: z.uuid(), hotelIds: z.array(z.uuid()) }),
  ),
});
export type PortalIntrospection = z.infer<typeof portalIntrospectionSchema>;

// --- "Faktury": portal-web → Finance (/api/internal/v1/portal/invoices*) -------------------------

export const PORTAL_INVOICE_PAGE_MAX = 50;

export const portalInvoiceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(PORTAL_INVOICE_PAGE_MAX).default(20),
});
export type PortalInvoiceListQuery = z.infer<typeof portalInvoiceListQuerySchema>;

/**
 * The one fixed ceiling of the invoice package between Finance and portal-web (review
 * 5845096918): Finance may be configured lower, never higher, checks the finished ZIP (overhead
 * included) against its own limit before sending, and portal-web cuts nothing a supported setting
 * can produce. portal-web waits a little longer than Finance, so Finance's refusal arrives first.
 */
export const PORTAL_PACKAGE_MAX_ZIP_BYTES = 40 * 1024 * 1024;
export const PORTAL_PACKAGE_MAX_MS = 60_000;
export const PORTAL_PACKAGE_PORTAL_GRACE_MS = 5_000;

/**
 * "Balíček za období" (doc 040 §14): the visible invoices whose billed month lies in [from, to],
 * at most PORTAL_PACKAGE_MAX_MONTHS months, as one ZIP of their PDFs and a manifest.csv. A
 * summary invoice is included once. Bounded in documents and bytes (Finance's env).
 */
export const PORTAL_PACKAGE_MAX_MONTHS = 12;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
export const portalInvoicePackageQuerySchema = z
  .object({ from: month, to: month })
  .refine((q) => q.from <= q.to, { message: 'from after to', path: ['from'] })
  .refine((q) => monthIndex(q.to) - monthIndex(q.from) < PORTAL_PACKAGE_MAX_MONTHS, {
    message: `at most ${PORTAL_PACKAGE_MAX_MONTHS} months`,
    path: ['to'],
  });
export type PortalInvoicePackageQuery = z.infer<typeof portalInvoicePackageQuerySchema>;

/** One invoice as issued (its snapshot), its payment state and whether it was cancelled. */
export const portalInvoiceSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  /** TEST invoices only outside production; labelled so in the portal. */
  kind: z.enum(['TEST']),
  issuedOn: z.iso.date(),
  dueOn: z.iso.date(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  total: z.string(),
  currency: z.string(),
  hotels: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string() })),
  paymentState: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']),
  paid: z.string(),
  remaining: z.string(),
  cancelled: z.boolean(),
});
export type PortalInvoice = z.infer<typeof portalInvoiceSchema>;

export const portalInvoicePageSchema = z.object({
  items: z.array(portalInvoiceSchema),
  /** The number of visible invoices — never counts another payer's or hotel's invoice. */
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type PortalInvoicePage = z.infer<typeof portalInvoicePageSchema>;
