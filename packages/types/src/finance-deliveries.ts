import { z } from 'zod';
import { documentLanguageSchema } from './finance-billing.js';

/**
 * Sending an invoice's stored PDF by e-mail by hand (doc 043, owner 2026-10-30). SENT means the mail
 * relay accepted the message, never that it reached the mailbox. UNCERTAIN is never retried
 * automatically: only a person, with a reason and knowing the customer may get it twice.
 */
export const INVOICE_DELIVERY_STATES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'UNCERTAIN',
] as const;
export const invoiceDeliveryStateSchema = z.enum(INVOICE_DELIVERY_STATES);
export type InvoiceDeliveryState = z.infer<typeof invoiceDeliveryStateSchema>;

export const invoiceDeliverySchema = z.object({
  id: z.uuid(),
  state: invoiceDeliveryStateSchema,
  recipient: z.string(),
  sender: z.string(),
  language: documentLanguageSchema,
  attemptOf: z.uuid().nullable(),
  retryReason: z.string().nullable(),
  code: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  requestedByName: z.string(),
  finishedAt: z.iso.datetime().nullable(),
  events: z.array(
    z.object({
      state: invoiceDeliveryStateSchema,
      code: z.string().nullable(),
      occurredAt: z.iso.datetime(),
    }),
  ),
});
export type InvoiceDelivery = z.infer<typeof invoiceDeliverySchema>;

/** What the invoice's page needs: the history and what sending would do now. */
export const invoiceDeliveriesSchema = z.object({
  /** false: sending is not configured here, or this invoice cannot be sent (see `blocker`). */
  sendable: z.boolean(),
  blocker: z
    .enum(['DELIVERY_DISABLED', 'INVOICE_CANCELLED', 'LANGUAGE_MISSING', 'PRODUCTION'])
    .nullable(),
  /**
   * How this server would send, from its configuration: SIMULATION opens no connection and nothing
   * leaves the system; RELAY sends a real test e-mail, only to the allowed addresses; null: off.
   */
  mode: z.enum(['SIMULATION', 'RELAY']).nullable(),
  /** The address a sending would use now (the customer's current billing e-mail). */
  recipient: z.string(),
  sender: z.string(),
  deliveries: z.array(invoiceDeliverySchema),
});
export type InvoiceDeliveries = z.infer<typeof invoiceDeliveriesSchema>;

/** The address the user saw is part of the request: a changed one is refused, never substituted. */
export const sendInvoiceSchema = z.object({
  requestId: z.uuid(),
  recipient: z.email().max(254),
});
export type SendInvoiceRequest = z.infer<typeof sendInvoiceSchema>;

export const retryInvoiceDeliverySchema = sendInvoiceSchema.extend({
  reason: z.string().trim().min(3).max(500),
  acknowledgeDuplicateRisk: z.literal(true),
});
export type RetryInvoiceDeliveryRequest = z.infer<typeof retryInvoiceDeliverySchema>;
