import { z } from 'zod';

/**
 * Hotels (doc 028, doc 007): one delivery address and contact per hotel, and the AYVO site that
 * serves it — chosen explicitly, never derived from the hotel's country (doc 022 §7). No
 * contracts, billing or hotel users yet.
 */

export const hotelCodeSchema = z.string().regex(/^HT-\d{6,}$/, 'e.g. HT-000001');

const text = (max: number) => z.string().trim().min(1).max(max);

export const createHotelRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: text(160),
  addressLine1: text(200),
  addressLine2: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((v) => (v ? v : null)),
  postalCode: text(20),
  city: text(120),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'),
  contactName: text(160),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()/-]{6,30}$/, 'Phone number'),
  contactEmail: z.email().max(254),
  fulfillmentSiteId: z.uuid(),
});
export type CreateHotelRequest = z.infer<typeof createHotelRequestSchema>;

const siteRef = z.object({ code: z.string(), name: z.string() });

export const deliveryAddressSchema = z.object({
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
});
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

export const hotelContactSchema = z.object({
  name: z.string(),
  phone: z.string(),
  email: z.string(),
});

export const hotelSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  city: z.string(),
  countryCode: z.string(),
  fulfillmentSite: siteRef,
  createdAt: z.iso.datetime(),
});
export type HotelSummary = z.infer<typeof hotelSummarySchema>;

/** Active sites with a warehouse that may serve a hotel (hotels:manage). */
export const fulfillmentSiteOptionSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
});
export type FulfillmentSiteOption = z.infer<typeof fulfillmentSiteOptionSchema>;

/** Optional practical details (doc 032) — never required of existing hotels. */
export const hotelPracticalSchema = z.object({
  /** Goods receipt hours, entrance, ramp, … (not sent to the carrier). */
  deliveryNote: z.string().nullable(),
  receivingContact: z
    .object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
});
export type HotelPractical = z.infer<typeof hotelPracticalSchema>;

export const hotelDetailSchema = hotelSummarySchema.extend({
  address: deliveryAddressSchema,
  contact: hotelContactSchema,
  practical: hotelPracticalSchema,
  createdBy: z.string(),
});
export type HotelDetail = z.infer<typeof hotelDetailSchema>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

/** "Upravit praktické údaje" (hotels:manage): only the optional details; a reason is required. */
export const updateHotelPracticalRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    deliveryNote: optionalText(500),
    receivingContactName: optionalText(160),
    receivingContactPhone: z
      .string()
      .trim()
      .regex(/^(\+?[0-9 ()/-]{6,30})?$/, 'Phone number')
      .nullable()
      .transform((v) => (v ? v : null)),
    receivingContactEmail: z
      .union([z.email().max(254), z.literal('')])
      .nullable()
      .transform((v) => (v ? v : null)),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (v) => !(v.receivingContactPhone || v.receivingContactEmail) || !!v.receivingContactName,
    { message: 'A receiving contact needs a name', path: ['receivingContactName'] },
  );
export type UpdateHotelPracticalRequest = z.infer<typeof updateHotelPracticalRequestSchema>;
