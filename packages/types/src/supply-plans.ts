import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { orderStatusSchema } from './orders.js';
import { isoDateSchema } from './procurement.js';

/**
 * Hotel supply plans (doc 032): one plan per hotel, rules of product × whole crates × days of the
 * month; ordinary orders are created from it automatically in the existing dispatch. Days are
 * local days of the hotel's serving site.
 */

export const supplyPlanStatusSchema = z.enum(['INACTIVE', 'ACTIVE', 'PAUSED']);
export type SupplyPlanStatus = z.infer<typeof supplyPlanStatusSchema>;

const dayOfMonth = z.number().int().min(1).max(31);

export const supplyPlanRuleInputSchema = z.strictObject({
  productCode: z.string().trim().min(1).max(40),
  crates: z.number().int().min(1).max(999),
  /** Days of the month 1–31; a day a month lacks is not planned that month (never moved). */
  days: z
    .array(dayOfMonth)
    .min(1)
    .max(31)
    .refine((d) => new Set(d).size === d.length, 'Each day once')
    .transform((d) => [...d].sort((a, b) => a - b)),
});
export type SupplyPlanRuleInput = z.infer<typeof supplyPlanRuleInputSchema>;

const planBody = {
  validFrom: isoDateSchema,
  validTo: isoDateSchema.nullable(),
  rules: z.array(supplyPlanRuleInputSchema).min(1).max(20),
};
const validRange = (v: { validFrom: string; validTo: string | null }) =>
  v.validTo === null || v.validTo >= v.validFrom;

/** Evaluates a plan (saved or being edited) without writing anything. */
export const supplyPlanPreviewRequestSchema = z
  .strictObject(planBody)
  .refine(validRange, { message: 'The end is before the start', path: ['validTo'] });
export type SupplyPlanPreviewRequest = z.infer<typeof supplyPlanPreviewRequestSchema>;

/** Creates or changes the plan (a new version); the reason is mandatory and audited. */
export const saveSupplyPlanRequestSchema = z
  .strictObject({ requestId: z.uuid(), ...planBody, reason: reasonSchema })
  .refine(validRange, { message: 'The end is before the start', path: ['validTo'] });
export type SaveSupplyPlanRequest = z.infer<typeof saveSupplyPlanRequestSchema>;

/** Switching on needs an explicit confirmation by an authorised user. */
export const activateSupplyPlanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export type ActivateSupplyPlanRequest = z.infer<typeof activateSupplyPlanRequestSchema>;

export const pauseSupplyPlanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type PauseSupplyPlanRequest = z.infer<typeof pauseSupplyPlanRequestSchema>;

/** Why an occurrence cannot become an order (shown as it is; never a partial order). */
export const supplyBlockerSchema = z.object({
  code: z.enum([
    'UNKNOWN_PRODUCT',
    'PRODUCT_WITHOUT_RECIPE',
    'SITE_WITHOUT_WAREHOUSE',
    'HOTEL_OF_ANOTHER_SITE',
    'SITE_INACTIVE',
  ]),
  product: z.string().nullable(),
});
export type SupplyBlocker = z.infer<typeof supplyBlockerSchema>;

export const supplyLineSchema = z.object({
  productCode: z.string(),
  productName: z.string(),
  crates: z.number().int(),
  /** From the current recipe's crate type — null when it cannot be known (a blocker). */
  crateType: z.string().nullable(),
  capacity: z.number().int().nullable(),
  bottles: z.number().int().nullable(),
});
export type SupplyLine = z.infer<typeof supplyLineSchema>;

const orderRef = z.object({
  code: z.string(),
  status: orderStatusSchema,
  origin: z.enum(['MANUAL', 'SUPPLY_PLAN']),
  requestedShipDate: isoDateSchema,
});

export const supplyPreviewDaySchema = z.object({
  shipDate: isoDateSchema,
  lines: z.array(supplyLineSchema),
  blockers: z.array(supplyBlockerSchema),
  /** Orders of this hotel already shipping that day (a possible overlap — never merged). */
  existingOrders: z.array(orderRef),
  /** This occurrence already exists: its order (also when cancelled or moved), or its blocker. */
  occurrence: z
    .object({ status: z.enum(['ORDERED', 'BLOCKED']), order: orderRef.nullable() })
    .nullable(),
  /** Inside the generation horizon (14 days): the next round creates it if nothing blocks it. */
  inHorizon: z.boolean(),
});
export type SupplyPreviewDay = z.infer<typeof supplyPreviewDaySchema>;

export const supplyPreviewSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  timeZone: z.string(),
  horizonDays: z.number().int(),
  days: z.array(supplyPreviewDaySchema),
  /** Rule days that do not exist in a month of the window — not planned that month. */
  skipped: z.array(z.object({ productCode: z.string(), day: z.number().int(), month: z.string() })),
  summary: z.object({
    orders: z.number().int(),
    blocked: z.number().int(),
    products: z.array(
      z.object({
        productCode: z.string(),
        productName: z.string(),
        crates: z.number().int(),
        bottles: z.number().int().nullable(),
      }),
    ),
  }),
});
export type SupplyPreview = z.infer<typeof supplyPreviewSchema>;

export const supplyPlanSchema = z.object({
  hotel: z.object({ code: z.string(), name: z.string() }),
  status: supplyPlanStatusSchema,
  version: z.number().int(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema.nullable(),
  rules: z.array(
    z.object({
      productCode: z.string(),
      productName: z.string(),
      crates: z.number().int(),
      days: z.array(z.number().int()),
    }),
  ),
  createdBy: z.string(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string(),
  activatedAt: z.iso.datetime().nullable(),
  activatedBy: z.string().nullable(),
  /** The background round's last look at this plan and its last success. */
  lastRunAt: z.iso.datetime().nullable(),
  lastRunOkAt: z.iso.datetime().nullable(),
  lastRunError: z.string().nullable(),
  /** The nearest planned ship day from today (null: none in the next 400 days). */
  nextShipDate: isoDateSchema.nullable(),
  /** Occurrences in the horizon that could not become orders, with their reason. */
  blocked: z.array(z.object({ shipDate: isoDateSchema, blockers: z.array(supplyBlockerSchema) })),
  /** Orders created from this plan, newest ship day first (their own state, never rewritten). */
  orders: z.array(orderRef.extend({ plannedShipDate: isoDateSchema })),
});
export type SupplyPlan = z.infer<typeof supplyPlanSchema>;

/** GET …/supply-plan: the hotel's plan or null (none yet). */
export const supplyPlanResponseSchema = z.object({ plan: supplyPlanSchema.nullable() });
export type SupplyPlanResponse = z.infer<typeof supplyPlanResponseSchema>;

/** "Změnit den odeslání" (orders:manage): explicit, with a reason; never in the past. */
export const rescheduleOrderRequestSchema = z.strictObject({
  requestId: z.uuid(),
  shipDate: isoDateSchema,
  reason: reasonSchema,
});
export type RescheduleOrderRequest = z.infer<typeof rescheduleOrderRequestSchema>;

/** Deliveries of a hotel per product and month (doc 032 §4) — from delivered parcels only. */
export const hotelDeliveriesSchema = z.object({
  timeZone: z.string(),
  months: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      products: z.array(
        z.object({
          productCode: z.string(),
          productName: z.string(),
          /** Parcels the carrier confirmed delivered (month of the delivery), their stored content. */
          deliveredCrates: z.number().int(),
          deliveredBottles: z.number().int(),
          /** Ordered and not delivered yet (month of the planned ship day; cancelled excluded). */
          openCrates: z.number().int(),
          openBottles: z.number().int(),
        }),
      ),
    }),
  ),
});
export type HotelDeliveries = z.infer<typeof hotelDeliveriesSchema>;
