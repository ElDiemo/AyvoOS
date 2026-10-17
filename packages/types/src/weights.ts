import { z } from 'zod';
import { isoDateSchema } from './procurement.js';

/**
 * Weights and dimensions (doc 025 §10, PR W1): measured references kept for future dispatch.
 * Masses are exact grams (decimal strings, up to 3 decimals), dimensions whole millimetres.
 * Unknown = absent (null), never 0 and never an estimate. One shipped crate = one parcel = one
 * shipping label; nothing here is a carrier limit, a shipment or an actual weighing.
 */

/** Exact grams: a positive decimal with at most 3 decimals (kept as a string, never a float). */
export const gramsSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'grams, up to 3 decimals')
  .refine((v) => Number(v) > 0, 'must be positive');
const mmSchema = z.number().int().min(1).max(10000);
const textSchema = z.string().trim().min(1).max(500);

const measurementInput = {
  requestId: z.uuid(),
  /** The day the measurement was taken (not in the future). */
  measuredOn: isoDateSchema,
  /** How it was measured (scale, sample, what was included). */
  method: textSchema,
  /** A correction refers to the record it corrects; the corrected value is kept. */
  correctionOf: z.uuid().nullable(),
  correctionReason: textSchema.nullable(),
};
const correctionRule = (v: { correctionOf: string | null; correctionReason: string | null }) =>
  (v.correctionOf === null) === (v.correctionReason === null);

export const recordItemWeightRequestSchema = z
  .strictObject({
    ...measurementInput,
    massG: gramsSchema,
    /** Volume items (a liquid) only: the weighed sample's volume in the item's base unit. */
    sampleVolume: gramsSchema.nullable(),
  })
  .refine(correctionRule, 'A correction needs its reason');
export type RecordItemWeightRequest = z.infer<typeof recordItemWeightRequestSchema>;

export const recordProductWeightRequestSchema = z
  .strictObject({
    ...measurementInput,
    /** One complete finished bottle (body + content + pump + label). */
    massG: gramsSchema,
    bottlesWeighed: z.number().int().min(1).max(10000),
  })
  .refine(correctionRule, 'A correction needs its reason');
export type RecordProductWeightRequest = z.infer<typeof recordProductWeightRequestSchema>;

export const recordTareRequestSchema = z
  .strictObject({ ...measurementInput, massG: gramsSchema, configuration: textSchema })
  .refine(correctionRule, 'A correction needs its reason');
export type RecordTareRequest = z.infer<typeof recordTareRequestSchema>;

export const dimensionSubjectSchema = z.enum(['CRATE', 'SHIPPING_PACKAGE']);
export type DimensionSubject = z.infer<typeof dimensionSubjectSchema>;
export const extraPackagingSchema = z.enum(['NONE', 'CARTON', 'PROTECTIVE_COVER', 'OTHER']);
export type ExtraPackaging = z.infer<typeof extraPackagingSchema>;

export const recordDimensionsRequestSchema = z
  .strictObject({
    ...measurementInput,
    subject: dimensionSubjectSchema,
    lengthMm: mmSchema,
    widthMm: mmSchema,
    heightMm: mmSchema,
    /** Shipping package only: an extra carton or cover, its mass (may stay unknown) and tare. */
    extraPackaging: extraPackagingSchema.nullable(),
    extraDescription: textSchema.nullable(),
    extraMassG: gramsSchema.nullable(),
    extraInTare: z.boolean().nullable(),
  })
  .refine(correctionRule, 'A correction needs its reason')
  .refine(
    (v) => (v.subject === 'CRATE') === (v.extraPackaging === null),
    'Extra packaging only on the shipping package',
  )
  .refine(
    (v) =>
      v.extraPackaging === 'NONE' || v.extraPackaging === null
        ? v.extraDescription === null && v.extraMassG === null && v.extraInTare === null
        : v.extraDescription !== null && v.extraInTare !== null,
    'Extra packaging needs a description and whether the tare includes it',
  );
export type RecordDimensionsRequest = z.infer<typeof recordDimensionsRequestSchema>;

const measurementMeta = {
  id: z.uuid(),
  measuredOn: isoDateSchema,
  method: z.string(),
  recordedAt: z.iso.datetime(),
  recordedBy: z.string(),
  correctionOf: z.uuid().nullable(),
  correctionReason: z.string().nullable(),
};

export const itemWeightSchema = z.object({
  ...measurementMeta,
  massG: z.string(),
  sampleVolume: z.string().nullable(),
});
export type ItemWeight = z.infer<typeof itemWeightSchema>;

export const itemWeightsSchema = z.object({
  item: z.object({
    code: z.string(),
    name: z.string(),
    kind: z.string(),
    unit: z.object({ code: z.string(), dimension: z.enum(['COUNT', 'VOLUME', 'MASS']) }),
  }),
  /** PER_UNIT: grams per base unit; SAMPLE: weighed sample of a stated volume; else none. */
  mode: z.enum(['PER_UNIT', 'SAMPLE', 'NOT_APPLICABLE']),
  current: itemWeightSchema.nullable(),
  history: z.array(itemWeightSchema),
});
export type ItemWeights = z.infer<typeof itemWeightsSchema>;

export const productWeightSchema = z.object({
  ...measurementMeta,
  massG: z.string(),
  bottlesWeighed: z.number().int(),
});
export type ProductWeight = z.infer<typeof productWeightSchema>;

export const tareWeightSchema = z.object({
  ...measurementMeta,
  massG: z.string(),
  configuration: z.string(),
});
export type TareWeight = z.infer<typeof tareWeightSchema>;

export const crateDimensionSchema = z.object({
  ...measurementMeta,
  subject: dimensionSubjectSchema,
  lengthMm: z.number().int(),
  widthMm: z.number().int(),
  heightMm: z.number().int(),
  extraPackaging: extraPackagingSchema.nullable(),
  extraDescription: z.string().nullable(),
  extraMassG: z.string().nullable(),
  extraInTare: z.boolean().nullable(),
});
export type CrateDimension = z.infer<typeof crateDimensionSchema>;

/**
 * How the final shipping package adds to the crate: not recorded yet; no extra packaging; extra
 * packaging already in the tare; added on top; or its mass unknown (then the package is unknown).
 */
export const packagingStateSchema = z.enum([
  'NOT_RECORDED',
  'NONE',
  'IN_TARE',
  'ADDED',
  'MASS_UNKNOWN',
]);
export type PackagingState = z.infer<typeof packagingStateSchema>;

/**
 * The EXPECTED (reference) weight of one full crate of a product — never an actual weighing:
 * bottles × finished-bottle reference + crate tare (+ extra packaging only when not in the tare).
 * The components are a separate cross-check, never added on top.
 */
export const crateExpectationSchema = z.object({
  recipeVersion: z.number().int().nullable(),
  crateType: z
    .object({ code: z.string(), name: z.string(), capacity: z.number().int() })
    .nullable(),
  bottleG: z.string().nullable(),
  tareG: z.string().nullable(),
  expectedCrateG: z.string().nullable(),
  packaging: z.object({
    state: packagingStateSchema,
    extraMassG: z.string().nullable(),
    description: z.string().nullable(),
  }),
  expectedPackageG: z.string().nullable(),
  /** What is still unmeasured for the expected values. */
  missing: z.array(z.enum(['BOTTLE', 'TARE', 'PACKAGE', 'PACKAGE_MASS', 'RECIPE'])),
  components: z.object({
    lines: z.array(
      z.object({
        item: z.object({ code: z.string(), name: z.string(), kind: z.string() }),
        quantity: z.string(),
        unitCode: z.string(),
        /** Mass of this line per bottle; null = unknown. */
        massG: z.string().nullable(),
      }),
    ),
    /** Sum per bottle when every line is known; else null (the unknown items are named). */
    sumG: z.string().nullable(),
    unknown: z.array(z.string()),
  }),
});
export type CrateExpectation = z.infer<typeof crateExpectationSchema>;

export const productWeightsSchema = z.object({
  product: z.object({ code: z.string(), name: z.string() }),
  current: productWeightSchema.nullable(),
  history: z.array(productWeightSchema),
  expectation: crateExpectationSchema,
});
export type ProductWeights = z.infer<typeof productWeightsSchema>;

const series = <T extends z.ZodType>(item: T) =>
  z.object({ current: item.nullable(), history: z.array(item) });

export const crateTypeMeasurementsSchema = z.object({
  crateType: z.object({ code: z.string(), name: z.string(), capacity: z.number().int() }),
  tare: series(tareWeightSchema),
  crate: series(crateDimensionSchema),
  package: series(crateDimensionSchema),
});
export type CrateTypeMeasurements = z.infer<typeof crateTypeMeasurementsSchema>;

/** The references used at one Hotovo of a crate (kept unchanged by later measurements). */
export const crateWeightSnapshotSchema = z.object({
  takenAt: z.iso.datetime(),
  bottles: z.number().int(),
  bottleG: z.string().nullable(),
  bottleMeasuredOn: isoDateSchema.nullable(),
  tareG: z.string().nullable(),
  tareMeasuredOn: isoDateSchema.nullable(),
  packaging: packagingStateSchema,
  extraMassG: z.string().nullable(),
  expectedCrateG: z.string().nullable(),
  expectedPackageG: z.string().nullable(),
});
export type CrateWeightSnapshot = z.infer<typeof crateWeightSnapshotSchema>;
export const crateWeightSnapshotsSchema = z.array(crateWeightSnapshotSchema);
