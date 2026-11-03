import { z } from 'zod';
import { billingTimingSchema } from './finance-billing.js';
import { currencySchema } from './finance.js';
import { hotelCodeSchema } from './hotels.js';
import { isoDateSchema } from './procurement.js';
import { prospectCodeSchema } from './sales.js';

/**
 * Contract drafts — a manual generator (owner 2026-11-03, ADR 0043, doc 045). A draft exists only
 * after an explicit save, belongs to a prospect or a hotel, and is printed from one versioned
 * Czech working template marked "NÁVRH – K PRÁVNÍ KONTROLE". Nothing here creates a hotel,
 * changes billing, sends or signs anything.
 */

export const contractDraftCodeSchema = z.string().regex(/^SN-\d{6,}$/, 'e.g. SN-000001');

/** The working templates in the repository; each revision records the one it was made with. */
export const CONTRACT_TEMPLATE_VERSIONS = ['cs-b2b-1'] as const;
export const contractTemplateVersionSchema = z.enum(CONTRACT_TEMPLATE_VERSIONS);
export const CURRENT_CONTRACT_TEMPLATE = 'cs-b2b-1' as const;

export const CONTRACT_HOLDERS = ['NONE', 'WITH'] as const;
export const CONTRACT_HOLDER_OWNERSHIPS = ['AYVO', 'CUSTOMER'] as const;

const text = (max: number) => z.string().trim().min(1, 'Vyplňte.').max(max);
/** Optional text: empty = not filled in (printed as a blank line to complete by hand). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

/** A price per room and month without VAT: exact, more than 0, at most 2 decimals (never rounded). */
export const contractPriceSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Cenu zadejte číslem s nejvýš 2 desetinnými místy.')
  .refine((v) => Number(v) > 0, 'Cena musí být větší než 0.');

/**
 * Everything the wizard asks for. Holders: without them the ownership is null; with them it is
 * required — the server refuses a mismatch (HOLDERS_OWNERSHIP_MISMATCH), the database too.
 */
export const contractDraftFieldsSchema = z.strictObject({
  counterpartyName: text(200),
  /** IČO; optional while negotiating (a blank line in the PDF). */
  counterpartyCompanyId: optionalText(30),
  counterpartyAddress: optionalText(400),
  representativeName: optionalText(160),
  representativeRole: optionalText(120),
  hotelName: text(200),
  hotelAddress: text(400),
  rooms: z.number().int().min(1).max(100_000),
  pricePerRoomMonth: contractPriceSchema,
  currency: currencySchema,
  startOn: isoDateSchema,
  billingTiming: billingTimingSchema,
  paymentTermsDays: z.number().int().min(0).max(365),
  holders: z.enum(CONTRACT_HOLDERS),
  holdersOwnership: z.enum(CONTRACT_HOLDER_OWNERSHIPS).nullable(),
});
export type ContractDraftFields = z.infer<typeof contractDraftFieldsSchema>;

/** True when the holder choice is consistent (the rule the server and the DB hold). */
export const holdersConsistent = (f: Pick<ContractDraftFields, 'holders' | 'holdersOwnership'>) =>
  (f.holders === 'WITH') === (f.holdersOwnership !== null);

/** POST /api/admin/contracts/drafts — from a prospect or a hotel; written only by this call. */
export const createContractDraftSchema = z
  .strictObject({
    requestId: z.uuid(),
    prospectCode: prospectCodeSchema.nullable(),
    /** The hotel chosen by hand (sales:manage + hotels:read); prefilled from a hotel's card. */
    hotelCode: hotelCodeSchema.nullable(),
    fields: contractDraftFieldsSchema,
  })
  .refine((r) => r.prospectCode !== null || r.hotelCode !== null, {
    message: 'Návrh patří k akvizici nebo k hotelu.',
    path: ['prospectCode'],
  });
export type CreateContractDraftRequest = z.infer<typeof createContractDraftSchema>;

/** POST drafts/:code/revisions — a new revision of the content, from the version seen. */
export const reviseContractDraftSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  reason: text(500),
  fields: contractDraftFieldsSchema,
});
export type ReviseContractDraftRequest = z.infer<typeof reviseContractDraftSchema>;

/** POST drafts/:code/remove | restore — confirmed, with a reason; removal is restorable. */
export const removeContractDraftSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  reason: text(500),
  confirm: z.literal(true, 'Potvrďte.'),
});
export type RemoveContractDraftRequest = z.infer<typeof removeContractDraftSchema>;

/** POST drafts/:code/hotel — link an existing hotel by hand (sales:manage + hotels:read). */
export const linkContractHotelSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  hotelCode: hotelCodeSchema,
  reason: text(500),
});
export type LinkContractHotelRequest = z.infer<typeof linkContractHotelSchema>;

export const CONTRACT_EVENT_KINDS = [
  'CREATED',
  'REVISED',
  'REMOVED',
  'RESTORED',
  'HOTEL_LINKED',
  'PDF_DOWNLOADED',
  'SIGNED_UPLOADED',
  'SIGNED_DOWNLOADED',
] as const;

export const contractDraftRevisionSchema = z.object({
  revision: z.number().int(),
  templateVersion: contractTemplateVersionSchema,
  fields: contractDraftFieldsSchema,
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
});
export type ContractDraftRevision = z.infer<typeof contractDraftRevisionSchema>;

export const contractDraftSummarySchema = z.object({
  code: contractDraftCodeSchema,
  version: z.number().int(),
  currentRevision: z.number().int(),
  counterpartyName: z.string(),
  hotelName: z.string(),
  prospect: z.object({ code: z.string(), name: z.string() }).nullable(),
  hotel: z.object({ code: z.string(), name: z.string() }).nullable(),
  removed: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type ContractDraftSummary = z.infer<typeof contractDraftSummarySchema>;

export const contractDraftDetailSchema = contractDraftSummarySchema.extend({
  removedAt: z.iso.datetime().nullable(),
  removeReason: z.string().nullable(),
  revisions: z.array(contractDraftRevisionSchema),
  events: z.array(
    z.object({
      kind: z.enum(CONTRACT_EVENT_KINDS),
      revision: z.number().int().nullable(),
      at: z.iso.datetime(),
      actorName: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  /** Whether the caller may link a hotel here (sales:manage + hotels:read). */
  canLinkHotel: z.boolean(),
});
export type ContractDraftDetail = z.infer<typeof contractDraftDetailSchema>;

/** GET drafts/prefill?prospect=|hotel= — the context to start from; nothing is written. */
export const contractDraftPrefillSchema = z.object({
  prospect: z.object({ code: z.string(), name: z.string() }).nullable(),
  hotel: z.object({ code: z.string(), name: z.string() }).nullable(),
  fields: z.object({
    counterpartyName: z.string().nullable(),
    hotelName: z.string().nullable(),
    hotelAddress: z.string().nullable(),
    rooms: z.number().int().nullable(),
  }),
  /** Hotels the caller may link by hand (empty without sales:manage + hotels:read). */
  hotels: z.array(z.object({ code: z.string(), name: z.string() })),
});
export type ContractDraftPrefill = z.infer<typeof contractDraftPrefillSchema>;
