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
  /** The payer version Finance checked against. */
  payerVersionId: z.uuid(),
  /** The hotels Finance confirmed as the payer's — exactly the grant's hotels. */
  hotelIds: hotelIdsSchema,
  checkedAt: z.iso.datetime({ offset: true }),
});
export type PortalGrantFinanceCheck = z.infer<typeof portalGrantFinanceCheckSchema>;

const grantBody = z.strictObject({
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
