import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CancelInvoiceRequest,
  CreateTestInvoiceRequest,
  CreateTestRunRequest,
  EffectiveTermsPage,
  InvoiceDetail,
  InvoiceListQuery,
  InvoicesOverview,
  InvoiceSummary,
  TestRunPreview,
  TestRunResult,
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
import { invoicePaymentState } from './payments.service.js';
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
  allocations: {
    include: { payment: { select: { code: true } } },
    orderBy: { recordedAt: 'asc' },
  },
} satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

/** A stable request id of one invoice of a run (invoices.request_id is unique per invoice). */
const lineRequestId = (runRequestId: string, agreementCode: string) => {
  const h = createHash('sha256').update(`${runRequestId}:${agreementCode}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** The lines against the terms under the lock: complete and exactly what the user saw, or nothing. */
function bindLines(terms: EffectiveTermsPage, seenLines: CreateTestInvoiceRequest['lines']) {
  return seenLines.map((seen) => {
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
}

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

  async list(query: InvoiceListQuery = {}): Promise<InvoiceSummary[]> {
    const rows = await this.prisma.invoice.findMany({
      where: query.agreement ? { lines: { some: { agreement: { code: query.agreement } } } } : {},
      orderBy: { serial: 'desc' },
      include: invoiceInclude,
    });
    return rows.map(summary);
  }

  /**
   * The Finance overview's sums (doc 042 §3a), aggregated in the database: valid invoices with a
   * remaining amount per currency (overdue = due before today in Prague, as `invoicePaymentState`)
   * and two separate counts of incoming payments a person has to look at: with an amount not yet
   * allocated, and changed by the bank after they were recorded (`bankChangedSinceRecorded`, also
   * when fully allocated — review FIN90-R1; nothing is re-allocated). Reads only.
   */
  async overview(): Promise<InvoicesOverview> {
    const [rows, [payments], [changed]] = await Promise.all([
      this.prisma.$queryRaw<
        { currency: string; open: number; open_rem: string; overdue: number; overdue_rem: string }[]
      >`
        WITH open AS (
          SELECT i."currency", i."due_on",
                 i."total" - coalesce((SELECT sum(a."amount") FROM "finance"."payment_allocations" a
                                       WHERE a."invoice_id" = i."id"), 0) AS "remaining"
          FROM "finance"."invoices" i
          WHERE NOT EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c
                            WHERE c."invoice_id" = i."id"))
        SELECT "currency",
               count(*)::int AS "open",
               sum("remaining")::text AS "open_rem",
               (count(*) FILTER (WHERE "due_on" < ${pragueToday()}::date))::int AS "overdue",
               coalesce(sum("remaining") FILTER (WHERE "due_on" < ${pragueToday()}::date), 0)::text
                 AS "overdue_rem"
        FROM open WHERE "remaining" > 0
        GROUP BY "currency" ORDER BY "currency"`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS "count" FROM "finance"."incoming_payments" p
        WHERE p."amount" > coalesce((SELECT sum(a."amount") FROM "finance"."payment_allocations" a
                                     WHERE a."payment_id" = p."id"), 0)`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS "count" FROM "finance"."incoming_payments" p
        WHERE p."bank_transaction_version" IS NOT NULL
          AND (SELECT max(v."version") FROM "finance"."bank_transaction_versions" v
               WHERE v."transaction_id" = p."bank_transaction_id") > p."bank_transaction_version"`,
    ]);
    const money = (v: string) => new Prisma.Decimal(v).toFixed(2);
    return {
      invoices: rows.map((r) => ({
        currency: r.currency,
        open: { count: r.open, remaining: money(r.open_rem) },
        overdue: { count: r.overdue, remaining: money(r.overdue_rem) },
      })),
      paymentsToReview: payments!.count,
      paymentsChangedAtBank: changed!.count,
    };
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
    const { userId } = caller.principal;
    try {
      const { result } = await this.operations.run(
        'INVOICE_TEST_ISSUE',
        req.requestId,
        { month: req.month, lines: req.lines, actorId: userId },
        async (tx) => {
          const terms = await this.lockedTerms(tx, req.month);
          return this.issueOne(tx, terms, req, pragueToday(), caller);
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

  /**
   * A month's agreements and what a TEST invoice of each would say (doc 040 §11). Nothing is saved
   * or decided here: a blocked agreement says why; the billing timing is only shown.
   */
  async testRunPreview(month: string): Promise<TestRunPreview> {
    const [terms, invoiced] = await Promise.all([
      this.billing.effectiveTerms(month),
      this.invoicedInMonth(this.prisma, month),
    ]);
    return {
      month,
      issuable: this.env.APP_ENV !== 'production',
      items: terms.items.map((t) => {
        const v = t.version;
        const invoiceNumber = invoiced.get(t.agreement.code) ?? null;
        const amount =
          v && t.price.perRoomMonth !== null
            ? new Prisma.Decimal(t.price.perRoomMonth).mul(v.billedRooms).toFixed(2)
            : null;
        const blockers: string[] = [...t.gaps];
        if (amount !== null && new Prisma.Decimal(amount).isZero()) blockers.push('ZERO_AMOUNT');
        if (blockers.length === 0 && (!v || !t.customer || amount === null))
          blockers.push('NO_EFFECTIVE_VERSION');
        return {
          agreementCode: t.agreement.code,
          hotel: { code: t.agreement.hotel.code, name: t.agreement.hotel.name },
          state:
            t.status !== 'IN_EFFECT'
              ? ('NOT_IN_EFFECT' as const)
              : invoiceNumber
                ? ('ALREADY_INVOICED' as const)
                : blockers.length > 0
                  ? ('BLOCKED' as const)
                  : ('READY' as const),
          blockers: t.status === 'IN_EFFECT' ? blockers : [],
          invoiceNumber,
          customer: t.customer
            ? {
                code: t.customer.code,
                legalName: t.customer.customer.legalName,
                version: t.customer.version,
              }
            : null,
          agreementRevision: v?.revision ?? null,
          billedRooms: v?.billedRooms ?? null,
          price: t.price,
          amount,
          currency: v?.currency ?? null,
          paymentTermsDays: v?.paymentTermsDays ?? null,
          billingTiming: v?.billingTiming ?? null,
        };
      }),
    };
  }

  /**
   * Separate TEST invoices of an explicit period and issue date (doc 040 §11): all or nothing in
   * one transaction, bound to the lines the user saw; the same requestId replays the same result.
   * A concurrent run or a single issue of the same agreement and month is refused by the database.
   */
  async issueTestRun(req: CreateTestRunRequest, caller: FinanceCaller): Promise<TestRunResult> {
    if (this.env.APP_ENV === 'production')
      throw domainError(
        409,
        'TEST_INVOICES_DISABLED',
        'Testovací faktury v produkci nevznikají; ostré vystavení není schváleno.',
      );
    try {
      const { result } = await this.operations.run(
        'INVOICE_TEST_RUN',
        req.requestId,
        {
          month: req.month,
          issuedOn: req.issuedOn,
          lines: req.lines,
          actorId: caller.principal.userId,
        },
        async (tx) => {
          const terms = await this.lockedTerms(tx, req.month);
          // Everything is checked before the first PDF is rendered and stored.
          bindLines(terms, req.lines);
          const invoiced = await this.invoicedInMonth(tx, req.month);
          const taken = req.lines.find((l) => invoiced.has(l.agreementCode));
          if (taken)
            throw domainErrorWithDetails(
              409,
              'ALREADY_INVOICED',
              'Některá smlouva už má na tento měsíc platnou testovací fakturu. Načtěte náhled znovu.',
              { code: taken.agreementCode, number: invoiced.get(taken.agreementCode) },
            );
          const invoices: { agreementCode: string; number: string }[] = [];
          for (const line of req.lines) {
            const { number } = await this.issueOne(
              tx,
              terms,
              {
                requestId: lineRequestId(req.requestId, line.agreementCode),
                month: req.month,
                lines: [line],
              },
              req.issuedOn,
              caller,
            );
            invoices.push({ agreementCode: line.agreementCode, number });
          }
          return { month: req.month, issuedOn: req.issuedOn, invoices };
        },
      );
      return result;
    } catch (e) {
      if (e instanceof Error && /already has a valid invoice/.test(e.message))
        throw domainError(
          409,
          'ALREADY_INVOICED',
          'Některá smlouva už má na tento měsíc platnou testovací fakturu. Načtěte náhled znovu.',
        );
      if (e instanceof InconsistentInvoiceSnapshot || e instanceof InvalidPaymentInstruction)
        throw domainError(422, 'INVOICE_NOT_CONSISTENT', e.message);
      throw e;
    }
  }

  /** Terms of a month under the lock every writer of terms, prices and customers takes (BILL86-R1). */
  private async lockedTerms(tx: Prisma.TransactionClient, month: string) {
    await tx.$executeRaw`SELECT 1 FROM "finance"."code_counters" WHERE "name" = 'billing_revision' FOR SHARE`;
    return this.billing.effectiveTerms(month, undefined, tx);
  }

  /** Valid invoices of a month by agreement code (cancelled ones free the month again). */
  private async invoicedInMonth(db: Prisma.TransactionClient, month: string) {
    const rows = await db.invoiceLine.findMany({
      where: {
        periodMonth: new Date(`${month}-01T00:00:00.000Z`),
        invoice: { cancellation: null },
      },
      select: { agreement: { select: { code: true } }, invoice: { select: { number: true } } },
    });
    return new Map(rows.map((r) => [r.agreement.code, r.invoice.number]));
  }

  /**
   * One TEST invoice inside the caller's transaction, bound to the terms the user saw; the issue
   * date is the caller's (today for a single invoice, the explicit date of a monthly run).
   */
  private async issueOne(
    tx: Prisma.TransactionClient,
    terms: EffectiveTermsPage,
    req: Pick<CreateTestInvoiceRequest, 'requestId' | 'month' | 'lines'>,
    issuedOn: string,
    caller: FinanceCaller,
  ): Promise<{ number: string }> {
    const { userId, displayName } = caller.principal;
    const chosen = bindLines(terms, req.lines);
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
    if (new Prisma.Decimal(total).lessThanOrEqualTo(0))
      throw domainError(
        422,
        'TERMS_INCOMPLETE',
        'Faktura by měla nulovou částku – nic se nevystavilo.',
      );
    const dueOn = addDays(issuedOn, first.version.paymentTermsDays);
    const year = issuedOn.slice(0, 4);
    const serial = await allocateFinanceSerial(tx, 'invoice_test');
    if (serial > 9999n) throw domainError(409, 'TEST_SERIES_FULL', 'Testovací řada je vyčerpána.');
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
      this.logger.warn(`Unreferenced test invoice PDF after a failed insert: ${pdfStorageKey}`);
      throw e;
    }
    return { number };
  }

  async cancel(
    number: string,
    req: CancelInvoiceRequest,
    caller: FinanceCaller,
  ): Promise<InvoiceDetail> {
    const { userId, displayName } = caller.principal;
    await this.operations
      .run(
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
      )
      .catch((e: unknown) => {
        if (e instanceof Error && /an invoice with payments is not cancelled/.test(e.message))
          throw domainError(
            409,
            'INVOICE_HAS_PAYMENTS',
            'Faktura má přiřazené platby – zrušit ji nelze.',
          );
        throw e;
      });
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
    paymentState: invoicePaymentState(r.total, r.allocations, r.dueOn, !!r.cancellation),
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
    allocations: r.allocations.map((a) => ({
      invoiceNumber: r.number,
      paymentCode: a.payment.code,
      amount: a.amount.toFixed(2),
      kind: a.kind as 'AUTO' | 'MANUAL',
      reason: a.reason,
      recordedAt: a.recordedAt.toISOString(),
      recordedByName: a.recordedByName,
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
