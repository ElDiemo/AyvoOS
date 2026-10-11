import { z } from 'zod';

/**
 * Label templates (labels module). Physical layout is authoritative in millimetres; the origin is
 * the top-left corner of the label, x grows to the right and y grows downwards.
 */

// --- QR geometry (shared by the browser preview and the PDF renderer) ----------------------------

/** Light margin around a QR symbol required by ISO/IEC 18004, in modules. */
export const QR_QUIET_ZONE_MODULES = 4;

export const qrErrorCorrectionSchema = z.enum(['L', 'M', 'Q', 'H']);
export type QrErrorCorrection = z.infer<typeof qrErrorCorrectionSchema>;

/**
 * Physical geometry of a QR element. The element box (xMm, yMm, widthMm) INCLUDES the quiet
 * zone; the symbol of `moduleCount` × `moduleCount` modules sits inside it with a margin of
 * QR_QUIET_ZONE_MODULES modules. The browser preview and the PDF renderer both use this.
 */
export function qrGeometry(
  box: { xMm: number; yMm: number; widthMm: number },
  moduleCount: number,
): {
  moduleMm: number;
  totalModules: number;
  symbol: { xMm: number; yMm: number; sizeMm: number };
} {
  const totalModules = moduleCount + 2 * QR_QUIET_ZONE_MODULES;
  const moduleMm = box.widthMm / totalModules;
  const inset = QR_QUIET_ZONE_MODULES * moduleMm;
  return {
    moduleMm,
    totalModules,
    symbol: { xMm: box.xMm + inset, yMm: box.yMm + inset, sizeMm: moduleCount * moduleMm },
  };
}

/** Template names are short technical identifiers, e.g. "mydlo1". */
export const labelTemplateNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    'Use 1–64 lowercase letters, digits, "-" or "_", starting with a letter or digit',
  );

export const LABEL_SIZE_MIN_MM = 10;
export const LABEL_SIZE_MAX_MM = 500;

/** Millimetre values are stored with two decimals (0.01 mm). */
const twoDecimals = (value: number) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
export const millimetresSchema = z
  .number()
  .finite()
  .refine(twoDecimals, 'At most two decimal places (0.01 mm)');

export const labelSizeMmSchema = millimetresSchema.pipe(
  z.number().min(LABEL_SIZE_MIN_MM).max(LABEL_SIZE_MAX_MM),
);

/** v0.1 implements QR_CODE only; BOTTLE_CODE, TEXT, BARCODE, BATCH_CODE may follow. */
export const labelElementTypeSchema = z.enum(['QR_CODE']);
export type LabelElementType = z.infer<typeof labelElementTypeSchema>;

/** A QR element box includes the QR quiet zone (4 modules), which is printed white. */
export const qrCodeElementSchema = z
  .object({
    type: z.literal('QR_CODE'),
    xMm: millimetresSchema.pipe(z.number().min(0)),
    yMm: millimetresSchema.pipe(z.number().min(0)),
    widthMm: millimetresSchema.pipe(z.number().positive()),
    heightMm: millimetresSchema.pipe(z.number().positive()),
    /** Rotation is not supported in v0.1. */
    rotationDeg: z.literal(0).default(0),
  })
  .refine((e) => e.widthMm === e.heightMm, {
    message: 'A QR code must be square',
    path: ['heightMm'],
  });

export const labelElementSchema = qrCodeElementSchema;
export type LabelElement = z.infer<typeof labelElementSchema>;

export const labelLayoutSchema = z
  .object({
    artworkId: z.uuid(),
    widthMm: labelSizeMmSchema,
    heightMm: labelSizeMmSchema,
    elements: z.array(labelElementSchema).min(1).max(20),
  })
  .superRefine((layout, ctx) => {
    const qrCount = layout.elements.filter((e) => e.type === 'QR_CODE').length;
    if (qrCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['elements'],
        message: 'Exactly one QR code is required',
      });
    }
    layout.elements.forEach((e, i) => {
      if (
        e.xMm + e.widthMm > layout.widthMm + 1e-9 ||
        e.yMm + e.heightMm > layout.heightMm + 1e-9
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i],
          message: 'The element must lie entirely on the label',
        });
      }
    });
  });
export type LabelLayout = z.infer<typeof labelLayoutSchema>;

/** POST /api/admin/label-templates — creates the template and its version 1. */
export const createLabelTemplateRequestSchema = z.object({
  name: labelTemplateNameSchema,
  layout: labelLayoutSchema,
});
export type CreateLabelTemplateRequest = z.infer<typeof createLabelTemplateRequestSchema>;

/** POST /api/admin/label-templates/:id/versions — a changed layout becomes a new version. */
export const createLabelTemplateVersionRequestSchema = z.object({ layout: labelLayoutSchema });
export type CreateLabelTemplateVersionRequest = z.infer<
  typeof createLabelTemplateVersionRequestSchema
>;

export const labelArtworkFormatSchema = z.enum(['SVG', 'PNG', 'JPEG']);
export type LabelArtworkFormat = z.infer<typeof labelArtworkFormatSchema>;

export const labelArtworkSchema = z.object({
  id: z.uuid(),
  format: labelArtworkFormatSchema,
  byteSize: z.number().int().positive(),
  originalFilename: z.string(),
  intrinsicWidth: z.number().positive(),
  intrinsicHeight: z.number().positive(),
  /** Physical size if the file states it unambiguously (SVG with mm/cm/in units), else null. */
  suggestedSizeMm: z.object({ widthMm: z.number(), heightMm: z.number() }).nullable(),
  /** Same-origin URL of the artwork bytes (admin only). */
  contentUrl: z.string(),
  createdAt: z.iso.datetime(),
});
export type LabelArtwork = z.infer<typeof labelArtworkSchema>;

/** Compact reference to a template version, e.g. for bottles, batches and print jobs. */
export const labelTemplateVersionRefSchema = z.object({
  versionId: z.uuid(),
  templateId: z.uuid(),
  templateName: z.string(),
  versionNumber: z.number().int().positive(),
  /** Display label, e.g. "mydlo1 v1". */
  label: z.string(),
});
export type LabelTemplateVersionRef = z.infer<typeof labelTemplateVersionRefSchema>;

export const labelTemplateVersionSchema = labelTemplateVersionRefSchema.extend({
  widthMm: z.number(),
  heightMm: z.number(),
  artwork: labelArtworkSchema,
  elements: z.array(labelElementSchema),
  createdAt: z.iso.datetime(),
});
export type LabelTemplateVersion = z.infer<typeof labelTemplateVersionSchema>;

export const labelTemplateSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  /** Archived templates cannot be used for new creation batches. */
  archivedAt: z.iso.datetime().nullable(),
  versionCount: z.number().int().nonnegative(),
  latestVersion: labelTemplateVersionSchema,
});
export type LabelTemplateSummary = z.infer<typeof labelTemplateSummarySchema>;

export const labelTemplateDetailSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  /** Newest first. */
  versions: z.array(labelTemplateVersionSchema).min(1),
});
export type LabelTemplateDetail = z.infer<typeof labelTemplateDetailSchema>;

export const createLabelTemplateVersionResponseSchema = z.object({
  /** false when the submitted layout equals the latest version (nothing was created). */
  created: z.boolean(),
  version: labelTemplateVersionSchema,
});
export type CreateLabelTemplateVersionResponse = z.infer<
  typeof createLabelTemplateVersionResponseSchema
>;

/** Settings the label designer needs from the API. */
export const labelDesignerSettingsSchema = z.object({
  qrMinSizeMm: z.number().positive(),
  artworkMaxBytes: z.number().int().positive(),
  /** Allowed difference between artwork and label proportions (fraction, e.g. 0.01 = 1%). */
  aspectRatioTolerance: z.number().positive(),
  /** Configured QR error correction (provisional until the physical print test). */
  qrErrorCorrection: qrErrorCorrectionSchema,
  /** A URL as long as a real bottle URL, for a realistic QR preview in the designer. */
  qrPreviewUrl: z.url(),
});
export type LabelDesignerSettings = z.infer<typeof labelDesignerSettingsSchema>;
