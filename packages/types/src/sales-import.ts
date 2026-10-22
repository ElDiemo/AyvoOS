import { z } from 'zod';
import { duplicateHintSchema, userRefSchema } from './sales.js';

/**
 * Obchod — CSV import and export of prospects (doc 034 §13). A preview writes nothing; only an
 * explicitly confirmed import creates prospects (all selected rows in one transaction) and keeps
 * a result record. The file itself is never stored.
 */

/** Upper limits of one import file (doc 034 §13): 2 MB, 2000 data rows, 60 columns. */
export const SALES_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SALES_IMPORT_MAX_ROWS = 2000;
export const SALES_IMPORT_MAX_COLUMNS = 60;
/** An export holds at most this many prospects; a larger list is filtered first. */
export const SALES_EXPORT_MAX_ROWS = 10000;

export const importCodeSchema = z.string().regex(/^IMP-\d{6,}$/, 'e.g. IMP-000001');

/** What a CSV column means. `original`: kept in the note as a labelled original value. */
export const IMPORT_FIELDS = [
  'name',
  'countryCode',
  'city',
  'addressLine1',
  'postalCode',
  'roomsEstimate',
  'accommodationType',
  'website',
  'source',
  'priority',
  'note',
  'contactLabel',
  'contactPosition',
  'contactEmail',
  'contactPhone',
  'original',
  'ignore',
] as const;
export const importFieldSchema = z.enum(IMPORT_FIELDS);
export type ImportField = z.infer<typeof importFieldSchema>;
/** Fields a column can fill at most once (`original` and `ignore` may repeat). */
export const SINGLE_IMPORT_FIELDS: readonly ImportField[] = IMPORT_FIELDS.filter(
  (f) => f !== 'original' && f !== 'ignore',
);

/** The first step: what the file contains (nothing is checked or written yet). */
export const importInspectionSchema = z.object({
  fileName: z.string(),
  encoding: z.enum(['UTF-8', 'windows-1250']),
  delimiter: z.enum([',', ';']),
  headers: z.array(z.string()),
  rowCount: z.number().int(),
  /** The first data rows, as read. */
  sample: z.array(z.array(z.string())),
  /** A proposal from the header names; the user decides. */
  suggested: z.array(importFieldSchema),
});
export type ImportInspection = z.infer<typeof importInspectionSchema>;

const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');

/** The user's decisions: one meaning per column, explicit defaults and per-row fixes. */
export const importOptionsSchema = z.strictObject({
  mapping: z.array(importFieldSchema).min(1).max(SALES_IMPORT_MAX_COLUMNS),
  defaults: z.strictObject({
    /** Only for rows without a country — chosen explicitly, never derived. */
    countryCode: countrySchema.nullable(),
    /** Only for contacts without a name, e.g. "Recepce" — chosen explicitly. */
    contactLabel: z.string().trim().min(1).max(160).nullable(),
  }),
  /** Fixes typed in the preview, by row number (the spreadsheet row; the header is row 1). */
  overrides: z
    .record(
      z.string().regex(/^\d+$/),
      z.strictObject({
        name: z.string().trim().min(1).max(200).optional(),
        countryCode: countrySchema.optional(),
      }),
    )
    .default({}),
  /** sales:manage only: the salesperson who will own the prospects; else the importer. */
  ownerId: z.uuid().nullable(),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

/** What a preview showed (the file's bytes and every decision shaping its rows), as a hash. */
export const importFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The confirmation: the rows to create, each duplicate explicitly confirmed as a new record, and
 * the fingerprint of the preview they were chosen in — another file or other decisions are refused.
 */
export const confirmImportSchema = importOptionsSchema.extend({
  requestId: z.uuid(),
  fingerprint: importFingerprintSchema,
  rows: z
    .array(z.strictObject({ row: z.number().int().min(2), acknowledgeDuplicates: z.boolean() }))
    .min(1)
    .max(SALES_IMPORT_MAX_ROWS),
});
export type ConfirmImportRequest = z.infer<typeof confirmImportSchema>;

export const IMPORT_ROW_ERRORS = [
  'NAME_MISSING',
  'NAME_TOO_LONG',
  'COUNTRY_MISSING',
  'COUNTRY_INVALID',
  'ROOMS_INVALID',
  'TYPE_INVALID',
  'PRIORITY_INVALID',
  'EMAIL_INVALID',
  'PHONE_INVALID',
  'CONTACT_LABEL_MISSING',
  'TEXT_TOO_LONG',
  'NOTE_TOO_LONG',
  'EXTRA_CELLS',
  'QUOTE_INVALID',
] as const;
export const importRowErrorSchema = z.object({
  code: z.enum(IMPORT_ROW_ERRORS),
  /** The field (or column header) concerned, when there is one. */
  field: z.string().nullable(),
  /** The offending value as read (shortened). */
  value: z.string().nullable(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const importPreviewRowSchema = z.object({
  row: z.number().int(),
  name: z.string().nullable(),
  countryCode: z.string().nullable(),
  city: z.string().nullable(),
  contact: z
    .object({
      label: z.string().nullable(),
      position: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .nullable(),
  priority: z.string().nullable(),
  roomsEstimate: z.number().int().nullable(),
  /** The note as it will be saved, including the labelled original values. */
  note: z.string().nullable(),
  errors: z.array(importRowErrorSchema),
  /** Other rows of the same file that look like the same hotel. */
  fileDuplicates: z.array(z.number().int()),
  /** Possible duplicates among the prospects the user may see. */
  duplicates: duplicateHintSchema.shape.accessible,
});
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;

export const importPreviewSchema = z.object({
  /** Sent back with the confirmation (the server confirms only what this preview showed). */
  fingerprint: importFingerprintSchema,
  owner: userRefSchema,
  rows: z.array(importPreviewRowSchema),
  counts: z.object({
    total: z.number().int(),
    valid: z.number().int(),
    withErrors: z.number().int(),
    withDuplicates: z.number().int(),
  }),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importResultSchema = z.object({
  code: z.string(),
  fileName: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  owner: userRefSchema,
  rowCount: z.number().int(),
  createdCount: z.number().int(),
  /** The created prospects the user may still see (one may have been handed over since). */
  created: z.array(z.object({ row: z.number().int(), code: z.string(), name: z.string() })),
  /** Created, but now owned by someone the user cannot see into. */
  createdNotVisible: z.number().int(),
  /** Rows not imported: not selected by the user (with errors or by choice). */
  skipped: z.array(z.object({ row: z.number().int(), errors: z.array(z.string()) })),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const importSummarySchema = z.object({
  code: z.string(),
  fileName: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  owner: z.string(),
  rowCount: z.number().int(),
  createdCount: z.number().int(),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;
