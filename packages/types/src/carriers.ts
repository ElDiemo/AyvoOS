import { z } from 'zod';

/**
 * Carrier settings of a site (doc 029 §9, doc 022 §8): PPL only in this stage. Credentials are
 * never part of any contract — a setting names a server-side connection, and the view says only
 * whether its credentials are set on the server.
 */

export const carrierConnectionSchema = z.object({
  /** Server-side connection code, e.g. PPL_TEST. */
  code: z.string(),
  /** TEST = the carrier's test environment: no real shipment. */
  environment: z.enum(['TEST', 'PRODUCTION']),
  /**
   * Whether usable credentials exist (never their value). UNREADABLE = stored in the
   * administration but not readable with the server's key.
   */
  credentials: z.enum(['SET', 'MISSING', 'UNREADABLE']),
  /** ADMIN = entered in the administration (encrypted); SERVER = the server environment file. */
  source: z.enum(['ADMIN', 'SERVER']).nullable(),
});
export type CarrierConnection = z.infer<typeof carrierConnectionSchema>;

export const carrierSettingsProblemSchema = z.enum([
  'DISABLED',
  'NO_CONNECTION',
  'UNKNOWN_CONNECTION',
  'CREDENTIALS_MISSING',
  'CREDENTIALS_UNREADABLE',
  'SENDER_INCOMPLETE',
  'NOT_VERIFIED',
  'VERIFIED_WITH_ANOTHER_CONNECTION',
  'NO_PRODUCT',
  'PRODUCT_NOT_VERIFIED',
]);
export type CarrierSettingsProblem = z.infer<typeof carrierSettingsProblemSchema>;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

export const pplSettingsInputSchema = z.strictObject({
  enabled: z.boolean(),
  connection: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/)
    .nullable(),
  sender: z.strictObject({
    // Lengths as documented by the PPL CPL API (address model).
    name: text(50),
    street: text(60),
    city: text(50),
    postalCode: text(10),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    contact: text(50),
    phone: text(30),
    email: z
      .union([z.email().max(50), z.literal('')])
      .nullable()
      .transform((v) => (v ? v : null)),
  }),
  productCode: z.string().trim().max(20).nullable(),
  /**
   * PPL delivers every label as PDF (preview, download) and, for printing, as ZPL at the resolution
   * of the site's printer (doc 030 §2) — the format belongs to the printer, not to the carrier.
   */
  label: z.strictObject({
    /** SINGLE = one label per parcel; A4 = additionally PPL's complete A4 PDF (PPL's layout). */
    layout: z.enum(['SINGLE', 'A4']),
  }),
});
export type PplSettingsInput = z.infer<typeof pplSettingsInputSchema>;

export const updatePplSettingsRequestSchema = pplSettingsInputSchema.extend({
  requestId: z.uuid(),
  /**
   * Required (true) to switch a site to a PRODUCTION connection: new shipments of the site are then
   * real PPL shipments. Never needed to keep a connection or to choose a TEST one.
   */
  confirmProduction: z.literal(true).optional(),
});
export type UpdatePplSettingsRequest = z.infer<typeof updatePplSettingsRequestSchema>;

export const verifyCarrierRequestSchema = z.strictObject({ requestId: z.uuid() });
export type VerifyCarrierRequest = z.infer<typeof verifyCarrierRequestSchema>;

export const pplSettingsSchema = pplSettingsInputSchema.extend({
  site: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  carrier: z.literal('PPL'),
  /** False until anything was saved for this site. */
  saved: z.boolean(),
  connections: z.array(carrierConnectionSchema),
  verified: z
    .object({
      at: z.iso.datetime(),
      by: z.string(),
      connection: z.string(),
      products: z.array(z.object({ code: z.string(), name: z.string() })),
    })
    .nullable(),
  /** Empty = complete: new shipments may use PPL at this site. */
  problems: z.array(carrierSettingsProblemSchema),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type PplSettings = z.infer<typeof pplSettingsSchema>;

/** The outcome of "Ověřit připojení" (no shipment, no pickup is created). */
export const verifyCarrierResultSchema = z.object({
  ok: z.boolean(),
  /** A short, non-secret reason when not ok. */
  error: z.string().nullable(),
  settings: pplSettingsSchema,
});
export type VerifyCarrierResult = z.infer<typeof verifyCarrierResultSchema>;

/** Správa systému → Dopravci (ADR 0027): a connection without any credential value. */
export const carrierConnectionAdminSchema = carrierConnectionSchema.extend({
  carrier: z.literal('PPL'),
  /** Whether the server can store credentials (has its encryption key). */
  keyAvailable: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type CarrierConnectionAdmin = z.infer<typeof carrierConnectionAdminSchema>;

/** Enters or replaces credentials; the secret is write-only (never returned). */
export const replaceCarrierCredentialsRequestSchema = z.strictObject({
  requestId: z.uuid(),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  reason: z.string().trim().min(3).max(500),
});
export type ReplaceCarrierCredentialsRequest = z.infer<
  typeof replaceCarrierCredentialsRequestSchema
>;
