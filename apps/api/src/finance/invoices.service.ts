import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CancelInvoiceRequest,
  CreateTestInvoiceRequest,
  InvoiceDetail,
  InvoiceSummary,
} from '@ayvo/types';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { BillingSettingsService } from './billing-settings.service.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';
import {
  checkInvoiceSnapshot,
  InconsistentInvoiceSnapshot,
  renderInvoicePdf,
  type InvoicePdfSnapshot,
} from './invoice-pdf.js';
import { InvalidPaymentInstruction } from './spayd.js';

const pad = (n: bigint, width: number) => n.toString().padStart(width, '0');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** Today in Prague as "YYYY-MM-DD". */
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};
const address = (a: {
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}) => [
  a.addressLine1,
  ...(a.addressLine2 ? [a.addressLine2] : []),
  `${a.postalCode} ${a.city}`,
  ...(a.countryCode === 'CZ' ? [] : [a.countryCode]),
];

const VAT_NOTE =
  'Testovací doklad – nejde o daňový doklad. DPH a účetní pravidla zatím nejsou schválena.';

const invoiceInclude = {
  lines: { include: { agreement: { select: { code: true } } }, orderBy: { lineNo: 'asc' } },
  cancellation: true,
  customer: { include: { customer: { select: { code: true } } } },
} satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

/**
 * TEST invoices (N3A-2b, doc 040 §9): from the terms effective for a month (one or more hotel
 * agreements of ONE customer, one currency, the same payment terms) to an invoice whose issuer,
 * customer, lines and payment instructions are frozen in its snapshot, with the PDF and QR Platba
 * rendered from that snapshot and stored create-only. Only outside production and only kind TEST:
 * nothing is sent to anyone and no live invoice can be made. A cancellation is a separate record.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    private readonly billing: BillingSettingsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  async list(): Promise<InvoiceSummary[]> {
    const rows = await this.prisma.invoice.findMany({
      orderBy: { serial: 'desc' },
      include: invoiceInclude,
    });
    return rows.map(summary);
  }

  async detail(number: string): Promise<InvoiceDetail> {
    return detail(await this.find(number));
  }

  /** The stored PDF, checked against the hash recorded at issuing. */
  async pdf(number: string): Promise<{ bytes: Buffer; filename: string }> {
    const row = await this.find(number);
    const bytes = await this.storage.get(row.pdfStorageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== row.pdfSha256)
      throw new Error(`The stored PDF of ${number} does not match its hash`);
    return { bytes, filename: `faktura-${number}.pdf` };
  }

  async issueTest(req: CreateTestInvoiceRequest, caller: FinanceCaller): Promise<InvoiceDetail> {
    if (this.env.APP_ENV === 'production')
      throw domainError(
        409,
        'TEST_INVOICES_DISABLED',
        'Testovací faktury v produkci nevznikají; ostré vystavení není schváleno.',
      );
    const { userId, displayName } = caller.principal;
    try {
      const { result } = await this.operations.run(
        'INVOICE_TEST_ISSUE',
        req.requestId,
        { month: req.month, lines: req.lines, actorId: userId },
        async (tx) => {
          // Bound to what the user saw: read under the lock every writer of terms, prices and customers
          // takes, then compared — nothing changes between this check and the commit (BILL86-R1).
          await tx.$executeRaw`SELECT 1 FROM "finance"."code_counters" WHERE "name" = 'billing_revision' FOR SHARE`;
          const terms = await this.billing.effectiveTerms(req.month, undefined, tx);
          const chosen = req.lines.map((seen) => {
            const code = seen.agreementCode;
            const t = terms.items.find((i) => i.agreement.code === code);
            if (!t)
              throw domainErrorWithDetails(422, 'AGREEMENT_NOT_FOUND', 'Smlouva neexistuje.', {
                code,
              });
            if (
              t.status !== 'IN_EFFECT' ||
              t.gaps.length > 0 ||
              !t.version ||
              !t.customer ||
              t.price.perRoomMonth === null
            )
              throw domainErrorWithDetails(
                422,
                'TERMS_INCOMPLETE',
                'Smlouva nemá pro tento měsíc úplné podmínky – nic se nedopočítává.',
                { code, status: t.status, gaps: t.gaps },
              );
            if (
              t.version.revision !== seen.agreementRevision ||
              t.customer.version !== seen.customerVersion ||
              t.price.perRoomMonth !== seen.unitPrice ||
              t.price.priceListVersionId !== seen.priceListVersionId ||
              t.version.billedRooms !== seen.billedRooms
            )
              throw domainErrorWithDetails(
                409,
                'TERMS_CHANGED',
                'Podmínky smlouvy se od načtení změnily – načtěte smlouvy znovu a zkontrolujte částky. Nic se nevystavilo.',
                { code },
              );
            return { ...t, version: t.version, customer: t.customer, price: t.price.perRoomMonth };
          });
          const first = chosen[0]!;
          const differ = (what: string, code: string) =>
            domainErrorWithDetails(
              422,
              code,
              `Jedna faktura má jednoho odběratele, jednu měnu a jednu splatnost (${what}).`,
              {},
            );
          if (chosen.some((c) => c.customer.id !== first.customer.id))
            throw differ('odběratel', 'CUSTOMERS_DIFFER');
          if (chosen.some((c) => c.version.currency !== first.version.currency))
            throw differ('měna', 'CURRENCIES_DIFFER');
          if (chosen.some((c) => c.version.paymentTermsDays !== first.version.paymentTermsDays))
            throw differ('splatnost', 'PAYMENT_TERMS_DIFFER');
          const currency = first.version.currency;
          // The customer's newest version must be the one shown; the invoice records that version.
          const latestCustomer = await tx.customerVersion.findFirst({
            where: { customerId: first.customer.id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          if (latestCustomer?.version !== first.customer.version)
            throw domainError(
              409,
              'TERMS_CHANGED',
              'Údaje odběratele se od načtení změnily – načtěte smlouvy znovu. Nic se nevystavilo.',
            );

          const [issuer, defaults] = await Promise.all([
            tx.issuerVersion.findFirst({ orderBy: { version: 'desc' } }),
            tx.issuerDefaultAccount.findFirst({
              where: { currency },
              orderBy: { revision: 'desc' },
              include: {
                account: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } },
              },
            }),
          ]);
          const account = defaults?.account.versions[0];
          if (!issuer || !account || account.status !== 'ACTIVE' || account.currency !== currency)
            throw domainErrorWithDetails(
              422,
              'ISSUER_NOT_READY',
              'Chybí údaje naší firmy nebo aktivní výchozí účet pro tuto měnu (Naše firma a účty).',
              { currency, issuer: !!issuer, account: !!account && account.status === 'ACTIVE' },
            );

          const lines = chosen.map((c, i) => {
            const rooms = c.version.billedRooms;
            const amount = new Prisma.Decimal(c.price).mul(rooms).toFixed(2);
            return {
              lineNo: i + 1,
              agreementId: c.agreement.id,
              agreementRevision: BigInt(c.version.revision),
              hotel: c.agreement.hotel,
              billedRooms: rooms,
              unitPrice: c.price,
              amount,
            };
          });
          const total = lines.reduce((s, l) => s.plus(l.amount), new Prisma.Decimal(0)).toFixed(2);
          const issuedOn = pragueToday();
          const dueOn = addDays(issuedOn, first.version.paymentTermsDays);
          const year = issuedOn.slice(0, 4);
          const serial = await allocateFinanceSerial(tx, 'invoice_test');
          if (serial > 9999n)
            throw domainError(409, 'TEST_SERIES_FULL', 'Testovací řada je vyčerpána.');
          const number = `T${year}-${pad(serial, 5)}`;
          const variableSymbol = `99${year}${pad(serial, 4)}`;
          const snapshot: InvoicePdfSnapshot = {
            environment: 'TEST',
            number,
            issuedOn,
            taxPointOn: null,
            dueOn,
            period: req.month,
            issuer: {
              legalName: issuer.legalName,
              address: address(issuer),
              companyId: issuer.companyId,
              vatId: issuer.vatId,
              registration: issuer.registration,
              email: issuer.email,
              phone: issuer.phone,
              web: issuer.web,
            },
            customer: {
              legalName: first.customer.customer.legalName,
              address: address(first.customer.customer),
              companyId: first.customer.customer.companyId,
              vatId: first.customer.customer.vatId,
            },
            hotels: lines.map((l) => ({ code: l.hotel.code, name: l.hotel.name })),
            lines: lines.map((l) => ({
              description: `Služba AYVO ${req.month.slice(5)}/${req.month.slice(0, 4)} – ${l.hotel.name}`,
              quantity: String(l.billedRooms),
              unit: 'pok.',
              unitPrice: l.unitPrice,
              amount: l.amount,
            })),
            totals: { base: null, vat: null, total, currency },
            vatNote: VAT_NOTE,
            payment: {
              account: account.accountNumber
                ? `${account.accountPrefix ? `${account.accountPrefix}-` : ''}${account.accountNumber}/${account.bankCode}`
                : null,
              iban: account.iban,
              bic: account.bic,
              amount: total,
              currency,
              variableSymbol,
              dueOn,
              message: `Faktura ${number}`,
            },
          };
          checkInvoiceSnapshot(snapshot);
          const pdf = await renderInvoicePdf(snapshot);
          const pdfStorageKey = newStorageKey('finance-documents', 'pdf');
          await this.storage.put(pdfStorageKey, pdf);
          try {
            await tx.invoice.create({
              data: {
                serial,
                kind: 'TEST',
                number,
                variableSymbol,
                customerId: first.customer.id,
                customerVersion: first.customer.version,
                periodMonth: new Date(`${req.month}-01T00:00:00.000Z`),
                issuedOn: new Date(`${issuedOn}T00:00:00.000Z`),
                dueOn: new Date(`${dueOn}T00:00:00.000Z`),
                currency,
                total,
                snapshot: snapshot as unknown as Prisma.InputJsonValue,
                pdfStorageKey,
                pdfSha256: createHash('sha256').update(pdf).digest('hex'),
                issuedBy: userId,
                issuedByName: displayName,
                requestId: req.requestId,
                lines: {
                  create: lines.map((l) => ({
                    lineNo: l.lineNo,
                    agreementId: l.agreementId,
                    agreementRevision: l.agreementRevision,
                    periodMonth: new Date(`${req.month}-01T00:00:00.000Z`),
                    hotelId: l.hotel.id,
                    hotelCode: l.hotel.code,
                    hotelName: l.hotel.name,
                    billedRooms: l.billedRooms,
                    unitPrice: l.unitPrice,
                    amount: l.amount,
                  })),
                },
              },
            });
          } catch (e) {
            this.logger.warn(
              `Unreferenced test invoice PDF after a failed insert: ${pdfStorageKey}`,
            );
            throw e;
          }
          return { number };
        },
      );
      return this.detail(result.number);
    } catch (e) {
      if (e instanceof Error && /already has a valid invoice/.test(e.message))
        throw domainError(
          409,
          'ALREADY_INVOICED',
          'Smlouva už má na tento měsíc platnou testovací fakturu (nejdřív ji zrušte).',
        );
      if (e instanceof InconsistentInvoiceSnapshot || e instanceof InvalidPaymentInstruction)
        throw domainError(422, 'INVOICE_NOT_CONSISTENT', e.message);
      throw e;
    }
  }

  async cancel(
    number: string,
    req: CancelInvoiceRequest,
    caller: FinanceCaller,
  ): Promise<InvoiceDetail> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'INVOICE_TEST_CANCEL',
      req.requestId,
      { number, reason: req.reason, actorId: userId },
      async (tx) => {
        const invoice = await tx.invoice.findUnique({
          where: { number },
          include: { cancellation: true },
        });
        if (!invoice) throw new NotFoundException('Faktura neexistuje.');
        if (invoice.cancellation)
          throw domainError(409, 'ALREADY_CANCELLED', 'Faktura už je zrušená.');
        await tx.invoiceCancellation.create({
          data: {
            invoiceId: invoice.id,
            reason: req.reason,
            cancelledBy: userId,
            cancelledByName: displayName,
            requestId: req.requestId,
          },
        });
        return { number };
      },
    );
    return this.detail(number);
  }

  private async find(number: string): Promise<InvoiceRow> {
    const row = await this.prisma.invoice.findUnique({
      where: { number },
      include: invoiceInclude,
    });
    if (!row) throw new NotFoundException('Faktura neexistuje.');
    return row;
  }
}

function summary(r: InvoiceRow): InvoiceSummary {
  return {
    number: r.number,
    kind: 'TEST',
    variableSymbol: r.variableSymbol,
    customer: {
      code: r.customer.customer.code,
      legalName: r.customer.legalName,
      version: r.customerVersion,
    },
    period: isoDay(r.periodMonth).slice(0, 7),
    issuedOn: isoDay(r.issuedOn),
    dueOn: isoDay(r.dueOn),
    currency: r.currency,
    total: r.total.toFixed(2),
    hotels: r.lines.map((l) => ({ code: l.hotelCode, name: l.hotelName })),
    status: r.cancellation ? 'CANCELLED' : 'VALID',
    cancellation: r.cancellation
      ? {
          reason: r.cancellation.reason,
          cancelledAt: r.cancellation.cancelledAt.toISOString(),
          cancelledByName: r.cancellation.cancelledByName,
        }
      : null,
    issuedAt: r.issuedAt.toISOString(),
    issuedByName: r.issuedByName,
    pdfSha256: r.pdfSha256,
  };
}

function detail(r: InvoiceRow): InvoiceDetail {
  const s = r.snapshot as unknown as InvoicePdfSnapshot;
  return {
    ...summary(r),
    lines: r.lines.map((l) => ({
      lineNo: l.lineNo,
      agreementCode: l.agreement.code,
      hotel: { code: l.hotelCode, name: l.hotelName },
      billedRooms: l.billedRooms,
      unitPrice: l.unitPrice.toFixed(2),
      amount: l.amount.toFixed(2),
    })),
    payment: {
      account: s.payment.account,
      iban: s.payment.iban,
      amount: s.payment.amount,
      currency: s.payment.currency,
      variableSymbol: s.payment.variableSymbol,
      dueOn: s.payment.dueOn,
    },
  };
}
