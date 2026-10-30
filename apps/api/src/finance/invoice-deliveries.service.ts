import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  InvoiceDeliveries,
  InvoiceDelivery,
  RetryInvoiceDeliveryRequest,
  SendInvoiceRequest,
} from '@ayvo/types';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';
import { INVOICE_MAIL_SENDER, renderInvoiceMail } from './invoice-mail.js';
import {
  INVOICE_MAIL_TRANSPORT,
  SEND_LEASE_MS,
  type InvoiceMailTransport,
  type SendOutcome,
} from './invoice-mail-transport.js';
import { documentLanguageOf, type InvoicePdfSnapshot } from './invoice-pdf.js';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Attempts that provably sent nothing before a delivery ends FAILED. */
const MAX_NOT_SENT_ATTEMPTS = 5;
const backoffMs = (attempts: number) => Math.min(300_000, 30_000 * 2 ** (attempts - 1));

type DeliveryRow = Prisma.InvoiceDeliveryGetPayload<{ include: { events: true } }>;

const asDelivery = (d: DeliveryRow): InvoiceDelivery => ({
  id: d.id,
  state: d.state as InvoiceDelivery['state'],
  recipient: d.recipient,
  sender: `${d.senderName} <${d.senderAddress}>`,
  language: d.language as InvoiceDelivery['language'],
  attemptOf: d.attemptOf,
  retryReason: d.retryReason,
  code: d.lastCode,
  requestedAt: d.requestedAt.toISOString(),
  requestedByName: d.requestedByName,
  finishedAt: d.finishedAt?.toISOString() ?? null,
  events: d.events
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .map((e) => ({
      state: e.state as InvoiceDelivery['state'],
      code: e.code,
      occurredAt: e.occurredAt.toISOString(),
    })),
});

/**
 * Sending an invoice's stored PDF by e-mail by hand (doc 043): nothing is recomputed or rendered
 * again but the e-mail around it. SMTP has no idempotency, so SENDING is committed before a
 * connection opens and an interrupted sending becomes UNCERTAIN, never queued again; a further
 * attempt is a person's decision with a reason. Accepted by the relay is all SENT ever means.
 */
@Injectable()
export class InvoiceDeliveriesService {
  private readonly logger = new Logger(InvoiceDeliveriesService.name);

  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
    @Inject(INVOICE_MAIL_TRANSPORT) private readonly transport: InvoiceMailTransport | null,
  ) {}

  private blockerOf(snapshot: unknown, cancelled: boolean): InvoiceDeliveries['blocker'] {
    if (!this.transport) return 'DELIVERY_DISABLED';
    // Only TEST invoices exist; they are never sent from production.
    if (this.env.APP_ENV === 'production') return 'PRODUCTION';
    if (cancelled) return 'INVOICE_CANCELLED';
    if (documentLanguageOf(snapshot) === null) return 'LANGUAGE_MISSING';
    return null;
  }

  async list(number: string): Promise<InvoiceDeliveries> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: {
        cancellation: { select: { invoiceId: true } },
        deliveries: { include: { events: true }, orderBy: { requestedAt: 'asc' } },
      },
    });
    if (!invoice) throw new NotFoundException('Faktura neexistuje.');
    const latest = await this.latestCustomerVersion(this.prisma, invoice.customerId);
    const blocker = this.blockerOf(invoice.snapshot, !!invoice.cancellation);
    return {
      sendable: blocker === null,
      mode: !this.env.FINANCE_INVOICE_MAIL
        ? null
        : this.env.FINANCE_INVOICE_MAIL === 'google-relay'
          ? 'RELAY'
          : 'SIMULATION',
      blocker,
      recipient: latest.billingEmail,
      sender: `${INVOICE_MAIL_SENDER.name} <${INVOICE_MAIL_SENDER.address}>`,
      deliveries: invoice.deliveries.map(asDelivery),
    };
  }

  private async latestCustomerVersion(db: Prisma.TransactionClient, customerId: string) {
    return db.customerVersion.findFirstOrThrow({
      where: { customerId },
      orderBy: { version: 'desc' },
      select: { version: true, billingEmail: true },
    });
  }

  /** The checks shared by a first sending and a retry, inside the request's transaction. */
  private async prepare(tx: Prisma.TransactionClient, number: string, seenRecipient: string) {
    // The lock every writer of customers takes: the address cannot change under this request.
    await tx.$executeRaw`SELECT 1 FROM "finance"."code_counters" WHERE "name" = 'billing_revision' FOR SHARE`;
    const invoice = await tx.invoice.findUnique({
      where: { number },
      include: { cancellation: { select: { invoiceId: true } } },
    });
    if (!invoice) throw new NotFoundException('Faktura neexistuje.');
    const blocker = this.blockerOf(invoice.snapshot, !!invoice.cancellation);
    if (blocker)
      throw domainError(
        409,
        blocker,
        {
          DELIVERY_DISABLED: 'Odesílání faktur tu není zapnuté.',
          PRODUCTION: 'Testovací faktury se z produkce neodesílají.',
          INVOICE_CANCELLED: 'Zrušená faktura se neodesílá.',
          LANGUAGE_MISSING: 'Starší doklad nemá uložený jazyk e-mailu, proto se neodesílá.',
        }[blocker],
      );
    const customer = await this.latestCustomerVersion(tx, invoice.customerId);
    if (customer.billingEmail !== seenRecipient)
      throw domainError(
        409,
        'RECIPIENT_CHANGED',
        'Adresa odběratele se změnila – načtěte stránku znovu. Nic se neodeslalo.',
      );
    const allowed = this.env.FINANCE_MAIL_TEST_RECIPIENTS?.split(',').map((a) => a.trim());
    if (allowed && !allowed.includes(seenRecipient))
      throw domainError(
        422,
        'RECIPIENT_NOT_ALLOWED',
        'Na tuto adresu se testovací faktura odeslat nesmí (seznam povolených příjemců).',
      );
    const snapshot = invoice.snapshot as unknown as InvoicePdfSnapshot;
    return {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerVersion: customer.version,
      recipient: seenRecipient,
      senderName: INVOICE_MAIL_SENDER.name,
      senderAddress: INVOICE_MAIL_SENDER.address,
      replyTo: INVOICE_MAIL_SENDER.address,
      language: snapshot.language,
      templateVersion: snapshot.templateVersion,
    };
  }

  async send(
    number: string,
    req: SendInvoiceRequest,
    caller: FinanceCaller,
  ): Promise<InvoiceDeliveries> {
    const { userId, displayName } = caller.principal;
    await this.operations
      .run(
        'INVOICE_DELIVERY_REQUEST',
        req.requestId,
        { number, recipient: req.recipient, actorId: userId },
        async (tx) => {
          const data = await this.prepare(tx, number, req.recipient);
          const first = await tx.invoiceDelivery.findFirst({
            where: { invoiceId: data.invoiceId },
            select: { id: true },
          });
          if (first)
            throw domainError(
              409,
              'DELIVERY_EXISTS',
              'Faktura už má záznam o odeslání. Další pokus je jen ruční opakování.',
            );
          const created = await tx.invoiceDelivery.create({
            data: {
              ...data,
              messageId: `<${randomUUID()}@ayvo.co>`,
              requestId: req.requestId,
              requestedBy: userId,
              requestedByName: displayName,
            },
          });
          return { id: created.id };
        },
      )
      .catch(alreadyLive);
    return this.list(number);
  }

  /** A person's further attempt after FAILED or UNCERTAIN: a new row, the same Message-ID. */
  async retry(
    number: string,
    deliveryId: string,
    req: RetryInvoiceDeliveryRequest,
    caller: FinanceCaller,
  ): Promise<InvoiceDeliveries> {
    const { userId, displayName } = caller.principal;
    await this.operations
      .run(
        'INVOICE_DELIVERY_RETRY',
        req.requestId,
        { number, deliveryId, recipient: req.recipient, reason: req.reason, actorId: userId },
        async (tx) => {
          const data = await this.prepare(tx, number, req.recipient);
          const previous = await tx.invoiceDelivery.findFirst({
            where: { id: deliveryId, invoiceId: data.invoiceId },
            include: { retry: { select: { id: true } } },
          });
          if (!previous) throw new NotFoundException('Záznam o odeslání neexistuje.');
          if (previous.retry || !['FAILED', 'UNCERTAIN'].includes(previous.state))
            throw domainErrorWithDetails(
              409,
              'DELIVERY_NOT_RETRYABLE',
              'Opakovat lze jen poslední neúspěšný nebo nejistý pokus.',
              { state: previous.state },
            );
          const created = await tx.invoiceDelivery.create({
            data: {
              ...data,
              messageId: previous.messageId,
              attemptOf: previous.id,
              retryReason: req.reason,
              duplicateRiskAcknowledged: req.acknowledgeDuplicateRisk,
              requestId: req.requestId,
              requestedBy: userId,
              requestedByName: displayName,
            },
          });
          return { id: created.id };
        },
      )
      .catch(alreadyLive);
    return this.list(number);
  }

  /** Interrupted sendings: the message may have left, so they are never queued again. */
  async settleInterrupted(): Promise<number> {
    const { count } = await this.prisma.invoiceDelivery.updateMany({
      where: { state: 'SENDING', leaseUntil: { lt: new Date() } },
      data: {
        state: 'UNCERTAIN',
        lastCode: 'PROCESS_INTERRUPTED',
        leaseUntil: null,
        finishedAt: new Date(),
      },
    });
    if (count > 0) this.logger.warn(`Invoice deliveries interrupted: ${count}`);
    return count;
  }

  /** Takes one due delivery (two processes never take the same one) and works on it. */
  async sendNext(): Promise<boolean> {
    if (!this.transport) return false;
    const claimed = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "finance"."invoice_deliveries"
        WHERE "state" = 'QUEUED' AND "next_attempt_at" <= clock_timestamp()
        ORDER BY "next_attempt_at" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!row) return null;
      // Committed before any connection opens: a crash from here on leaves SENDING.
      return tx.invoiceDelivery.update({
        where: { id: row.id },
        data: {
          state: 'SENDING',
          sendAttempts: { increment: 1 },
          leaseUntil: new Date(Date.now() + SEND_LEASE_MS),
          lastCode: null,
        },
        include: {
          invoice: { include: { cancellation: { select: { invoiceId: true } } } },
        },
      });
    });
    if (!claimed) return false;
    const outcome = await this.deliver(claimed);
    await this.finish(claimed.id, claimed.sendAttempts, outcome);
    return true;
  }

  private async deliver(
    d: Prisma.InvoiceDeliveryGetPayload<{
      include: { invoice: { include: { cancellation: { select: { invoiceId: true } } } } };
    }>,
  ): Promise<SendOutcome> {
    const { invoice } = d;
    if (invoice.cancellation) return { kind: 'REJECTED', code: 'INVOICE_CANCELLED' };
    if (this.env.APP_ENV === 'production') return { kind: 'REJECTED', code: 'PRODUCTION' };
    const snapshot = invoice.snapshot as unknown as InvoicePdfSnapshot;
    let pdf: Buffer;
    try {
      pdf = await this.storage.get(invoice.pdfStorageKey);
    } catch {
      return { kind: 'NOT_SENT', code: 'PDF_UNAVAILABLE' };
    }
    if (pdf.length > MAX_PDF_BYTES) return { kind: 'REJECTED', code: 'PDF_TOO_LARGE' };
    if (createHash('sha256').update(pdf).digest('hex') !== invoice.pdfSha256)
      return { kind: 'REJECTED', code: 'PDF_HASH_MISMATCH' };
    return this.transport!.send({
      ...renderInvoiceMail(snapshot),
      from: { name: d.senderName, address: d.senderAddress },
      replyTo: d.replyTo,
      to: d.recipient,
      messageId: d.messageId,
      pdf,
    });
  }

  /** Only from SENDING: a sending already settled as interrupted stays as it was recorded. */
  private async finish(id: string, attempts: number, outcome: SendOutcome): Promise<void> {
    const now = new Date();
    const data: Prisma.InvoiceDeliveryUpdateManyMutationInput =
      outcome.kind === 'ACCEPTED'
        ? { state: 'SENT', lastCode: null, leaseUntil: null, finishedAt: now }
        : outcome.kind === 'REJECTED' ||
            (outcome.kind === 'NOT_SENT' && attempts >= MAX_NOT_SENT_ATTEMPTS)
          ? { state: 'FAILED', lastCode: outcome.code, leaseUntil: null, finishedAt: now }
          : outcome.kind === 'NOT_SENT'
            ? {
                state: 'QUEUED',
                lastCode: outcome.code,
                leaseUntil: null,
                nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
              }
            : { state: 'UNCERTAIN', lastCode: outcome.code, leaseUntil: null, finishedAt: now };
    await this.prisma.invoiceDelivery.updateMany({ where: { id, state: 'SENDING' }, data });
    // The id and the class only: never an address, a message or the relay's own text.
    this.logger.log(`Invoice delivery ${id}: ${String(data.state)}`);
  }
}

/** Two requests at once: the partial unique indexes let one through. */
const alreadyLive = (e: unknown): never => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    throw domainError(409, 'DELIVERY_EXISTS', 'Faktura se právě odesílá nebo už má tento pokus.');
  throw e;
};
