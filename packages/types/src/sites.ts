import { z } from 'zod';
import { auditEventSchema, reasonSchema } from './identity.js';

/**
 * Sites — the physical AYVO facilities and the top-level operational boundary (doc 022,
 * ADR 0023). A site is not a country and not a legal entity.
 */
export const SITE_CAPABILITIES = ['WAREHOUSE', 'PRODUCTION', 'RETURNS'] as const;
export const siteCapabilitySchema = z.enum(SITE_CAPABILITIES);
export type SiteCapability = z.infer<typeof siteCapabilitySchema>;

export const siteCodeSchema = z.string().regex(/^[A-Z][A-Z0-9-]{1,19}$/, 'A–Z, 0–9 and -');

/** A valid IANA time zone ("Europe/Prague"); the database checks it again. */
export const timeZoneSchema = z
  .string()
  .regex(/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA time zone');

const addressSchema = z.object({
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((v) => (v ? v : null)),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(120),
});

const siteFieldsSchema = addressSchema.extend({
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'),
  timeZone: timeZoneSchema,
  defaultLocale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'e.g. cs-CZ'),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217'),
  capabilities: z
    .array(siteCapabilitySchema)
    .max(SITE_CAPABILITIES.length)
    .refine((c) => new Set(c).size === c.length, 'Duplicate capability'),
  reason: reasonSchema,
});

export const createSiteRequestSchema = siteFieldsSchema.extend({ code: siteCodeSchema });
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;

/** The code is immutable; everything else may be edited (with a reason, audited). */
export const updateSiteRequestSchema = siteFieldsSchema;
export type UpdateSiteRequest = z.infer<typeof updateSiteRequestSchema>;

export const siteStatusRequestSchema = z.object({ reason: reasonSchema });
export type SiteStatusRequest = z.infer<typeof siteStatusRequestSchema>;

/**
 * Warehouse codes are **globally** unique and immutable (doc 022 §2, §6) — the same rule as the
 * database CHECK; `MAIN` belongs to the initial site, so another site's warehouse gets its own code.
 */
export const warehouseCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_-]{1,19}$/, 'A–Z, 0–9, - and _ (2–20 characters)');

/** Suggested code of a site's (only) warehouse: `<SITE CODE>-MAIN`, when it fits the 20 limit. */
export function suggestedWarehouseCode(siteCode: string): string | null {
  const code = `${siteCode}-MAIN`;
  return warehouseCodeSchema.safeParse(code).success ? code : null;
}

/**
 * Creates the warehouse of a WAREHOUSE site that has none (v0.1: one warehouse per site, always
 * its default). Idempotent per `requestId`; the reason is audited.
 */
export const createSiteWarehouseRequestSchema = z.object({
  requestId: z.uuid(),
  code: warehouseCodeSchema,
  name: z.string().trim().min(1).max(80),
  reason: reasonSchema,
});
export type CreateSiteWarehouseRequest = z.infer<typeof createSiteWarehouseRequestSchema>;

export const siteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  /** The migrated initial site starts without an address. */
  addressComplete: z.boolean(),
  timeZone: z.string(),
  defaultLocale: z.string(),
  defaultCurrency: z.string(),
  capabilities: z.array(siteCapabilitySchema),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deactivatedAt: z.iso.datetime().nullable(),
  warehouses: z.array(z.object({ code: z.string(), name: z.string(), default: z.boolean() })),
});
export type Site = z.infer<typeof siteSchema>;

/** Why a site cannot be deactivated (or lose a capability) right now. */
export const siteDependencySchema = z.object({
  code: z.enum([
    'STOCK_ON_HAND',
    'WAREHOUSES',
    'LAST_ACTIVE_SITE',
    'HOTELS_SERVED',
    'ORDERS_NOT_CLOSED',
    'PARCELS_IN_TRANSIT',
  ]),
  detail: z.string(),
});
export type SiteDependency = z.infer<typeof siteDependencySchema>;

export const siteDetailSchema = siteSchema.extend({
  /** Blockers of deactivation; empty when the site may be deactivated. */
  deactivationBlockers: z.array(siteDependencySchema),
  audit: z.array(auditEventSchema),
});
export type SiteDetail = z.infer<typeof siteDetailSchema>;
