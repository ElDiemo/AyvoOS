import { z } from 'zod';
import { reasonSchema } from './identity.js';

/**
 * Hotel portal grants (ADR 0045 §4): which payer and which of its hotels a hotel portal (PORTAL)
 * account may see. Issued and replaced only through Finance, which checks the pair against its own
 * data and then calls the core's contract; revoked in the core. The payer is Finance's customer id,
 * opaque to the core.
 */

const hotelIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'each hotel once');

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** What Finance confirmed for this pair when it sent the grant (stored as it was sent). */
export const portalGrantFinanceCheckSchema = z.strictObject({
  /** The payer's (Finance customer's) version Finance checked against — its version number. */
  payerVersion: z.int().min(1),
  /** The hotels Finance confirmed as the payer's — exactly the grant's hotels. */
  hotelIds: hotelIdsSchema,
  checkedAt: z.iso.datetime({ offset: true }),
});
export type PortalGrantFinanceCheck = z.infer<typeof portalGrantFinanceCheckSchema>;

const grantBody = z.strictObject({
  /**
   * Finance's stable id of this one operation: a retry after a lost answer sends the same id and
   * gets the same result (the original grant and its original `financeCheck`), written once. The
   * same id with another actor, operation, account/grant, payer, hotels or reason is refused. A
   * retry may carry newer `financeCheck` evidence (a new `checkedAt` or `payerVersion`); that does
   * not make it another request.
   */
  requestId: z.uuid(),
  payerCustomerId: z.uuid(),
  hotelIds: hotelIdsSchema,
  reason: reasonSchema,
  financeCheck: portalGrantFinanceCheckSchema,
});
const confirmed = (b: { hotelIds: string[]; financeCheck: PortalGrantFinanceCheck }) =>
  sameSet(b.hotelIds, b.financeCheck.hotelIds);
const confirmedMessage = { message: 'financeCheck.hotelIds must be the grant hotels' };

/** Finance → core: a new grant for a PORTAL account. */
export const portalGrantIssueRequestSchema = grantBody
  .extend({ userId: z.uuid() })
  .refine(confirmed, confirmedMessage);
export type PortalGrantIssueRequest = z.infer<typeof portalGrantIssueRequestSchema>;

/** Finance → core: the active grant replaced by one with this hotel set (same user and payer). */
export const portalGrantReplaceRequestSchema = grantBody.refine(confirmed, confirmedMessage);
export type PortalGrantReplaceRequest = z.infer<typeof portalGrantReplaceRequestSchema>;

/** Admin → core: revocation (no Finance check: narrowing to nothing). */
export const portalGrantRevokeRequestSchema = z.strictObject({ reason: reasonSchema });
export type PortalGrantRevokeRequest = z.infer<typeof portalGrantRevokeRequestSchema>;

export const portalGrantSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  payerCustomerId: z.uuid(),
  hotelIds: z.array(z.uuid()),
  reason: z.string(),
  financeCheck: portalGrantFinanceCheckSchema,
  grantedAt: z.iso.datetime(),
  grantedBy: z.uuid(),
  replacesGrantId: z.uuid().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.uuid().nullable(),
  revokeReason: z.string().nullable(),
});
export type PortalGrant = z.infer<typeof portalGrantSchema>;

// --- the hotel portal account (Finance → core; created only with its first grant) -------------

const accountEmail = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/** Finance → core: the PORTAL account of this e-mail, created when there is none. */
export const portalAccountRequestSchema = z.strictObject({
  email: accountEmail,
  displayName: z.string().trim().min(1).max(200),
});
export type PortalAccountRequest = z.infer<typeof portalAccountRequestSchema>;

export const portalAccountSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  /** Created by this call (else it existed already). */
  created: z.boolean(),
});
export type PortalAccount = z.infer<typeof portalAccountSchema>;

/** Finance → core: invite the account — only once it holds an active grant (§4). */
export const portalInvitationRequestSchema = z.strictObject({ requestId: z.uuid() });
export type PortalInvitationRequest = z.infer<typeof portalInvitationRequestSchema>;

export const portalInvitationSchema = z.object({
  /** SENT now; OPEN = an invitation is already on its way; ACTIVE = the account already signs in. */
  state: z.enum(['SENT', 'OPEN', 'ACTIVE']),
});
export type PortalInvitation = z.infer<typeof portalInvitationSchema>;

/** A grant as Finance's payer page shows it (with its account). */
export const portalGrantListItemSchema = portalGrantSchema.extend({
  account: z.object({ email: z.string(), displayName: z.string(), signsIn: z.boolean() }),
});
export type PortalGrantListItem = z.infer<typeof portalGrantListItemSchema>;

// --- Finance's admin routes (the browser → Finance) ----------------------------------------------

/** "Přístup do portálu" on a payer page: a new grant (and the account, if new). */
export const financePortalGrantIssueSchema = z.strictObject({
  requestId: z.uuid(),
  /** The payer: Finance's customer id. */
  payerCustomerId: z.uuid(),
  email: accountEmail,
  displayName: z.string().trim().min(1).max(200),
  hotelIds: hotelIdsSchema,
  reason: reasonSchema,
});
export type FinancePortalGrantIssue = z.infer<typeof financePortalGrantIssueSchema>;

/** The grant's hotels changed (also narrowed): a replacement through the same check. */
export const financePortalGrantReplaceSchema = z.strictObject({
  requestId: z.uuid(),
  hotelIds: hotelIdsSchema,
  reason: reasonSchema,
});
export type FinancePortalGrantReplace = z.infer<typeof financePortalGrantReplaceSchema>;

/** The answer of an issue or a replacement through Finance. */
export const financePortalGrantResultSchema = z.object({
  grant: portalGrantSchema,
  /** Only on issue: the account the grant is for. */
  account: portalAccountSchema.omit({ created: true }).nullable(),
  /** Only on issue: the invitation, sent after the grant was written. FAILED = retry the request. */
  invitation: z.enum(['SENT', 'OPEN', 'ACTIVE', 'FAILED']).nullable(),
});
export type FinancePortalGrantResult = z.infer<typeof financePortalGrantResultSchema>;
