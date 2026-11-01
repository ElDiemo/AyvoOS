import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENTS_DEFAULT_PAGE_SIZE } from '@ayvo/types';
import type {
  PaymentOpenInvoices,
  PaymentsQuery,
  AllocatePaymentRequest,
  IncomingPayment,
  InvoicePaymentState,
  PaymentLoadResult,
  PaymentsPage,
  SimulateStatementRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

type Tx = Prisma.TransactionClient;
type MatchResult = IncomingPayment['matchResult'];

/** One entry to record as an incoming payment (from a bank transaction or a simulation). */
interface Entry {
  source: 'BANK' | 'SIMULATION';
  sourceKey: string;
  environment: 'PRODUCTION' | 'SANDBOX' | 'TEST' | 'SIMULATION';
  bankTransactionId: string | null;
  bankTransactionVersion: number | null;
  amount: Prisma.Decimal;
  currency: string;
  bookedOn: string;
  variableSymbol: string | null;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  message: string | null;
}

const ZERO = new Prisma.Decimal(0);
const sum = (xs: { amount: Prisma.Decimal }[]) => xs.reduce((s, x) => s.plus(x.amount), ZERO);
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

/** The payment state of an invoice from its allocations (overdue = past due and not paid). */
export function invoicePaymentState(
  total: Prisma.Decimal,
  allocations: { amount: Prisma.Decimal }[],
  dueOn: Date,
  cancelled: boolean,
): InvoicePaymentState {
  const paid = sum(allocations);
  const remaining = cancelled ? ZERO : total.minus(paid);
  const state = paid.isZero() ? 'UNPAID' : remaining.isZero() ? 'PAID' : 'PARTIALLY_PAID';
  return {
    state,
    paid: paid.toFixed(2),
    remaining: remaining.toFixed(2),
    overdue: !cancelled && state !== 'PAID' && dueOn.toISOString().slice(0, 10) < pragueToday(),
  };
}

const OPEN_INVOICES_LIMIT = 50;

const paymentInclude = {
  allocations: { include: { invoice: { select: { number: true } } } },
  bankTransaction: {
    select: { versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 } },
  },
} satisfies Prisma.IncomingPaymentInclude;
type PaymentRow = Prisma.IncomingPaymentGetPayload<{ include: typeof paymentInclude }>;

const likeEscape = (q: string) => q.replace(/[\\%_]/g, '\\$&');

/** The list's filters; REVIEW and CHANGED are the same conditions as the overview's counts. */
function paymentsWhere(query: PaymentsQuery): Prisma.Sql {
  const allocated = Prisma.sql`coalesce((SELECT sum(a."amount") FROM "finance"."payment_allocations" a WHERE a."payment_id" = p."id"), 0)`;
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.filter === 'REVIEW') parts.push(Prisma.sql`p."amount" > ${allocated}`);
  if (query.filter === 'ALLOCATED') parts.push(Prisma.sql`p."amount" = ${allocated}`);
  if (query.filter === 'CHANGED')
    parts.push(Prisma.sql`p."bank_transaction_version" IS NOT NULL
      AND (SELECT max(v."version") FROM "finance"."bank_transaction_versions" v
           WHERE v."transaction_id" = p."bank_transaction_id") > p."bank_transaction_version"`);
  if (query.q) {
    const like = `%${likeEscape(query.q)}%`;
    const amount = /^\d{1,15}([.,]\d{1,2})?$/.test(query.q) ? query.q.replace(',', '.') : null;
    parts.push(Prisma.sql`(p."code" ILIKE ${like} OR p."variable_symbol" ILIKE ${like}
      OR p."counterparty_name" ILIKE ${like}
      ${amount ? Prisma.sql`OR p."amount" = ${amount}::numeric` : Prisma.empty})`);
  }
  return Prisma.join(parts, ' AND ');
}

/**
 * Incoming payments (N3B-2, doc 041 §8): recorded once per source entry (a credit bank
 * transaction already read, or a simulated statement entry outside production), matched
 * deterministically — automatically only on an exact variable symbol of one open invoice in the
 * same currency and an allowed environment — and otherwise left for a person with the reason. A
 * person allocates with a reason. Nothing is ever sent to a bank; the database refuses any
 * allocation beyond the payment or the invoice.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  private get simulationAvailable() {
    return this.env.APP_ENV !== 'production';
  }

  /** One bounded page; the database filters, sorts and counts, nothing is loaded to be dropped. */
  async page(query: PaymentsQuery = {}): Promise<PaymentsPage> {
    const pageSize = query.pageSize ?? PAYMENTS_DEFAULT_PAGE_SIZE;
    const page = query.page ?? 1;
    const where = paymentsWhere(query);
    const [[count], ids] = await Promise.all([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total" FROM "finance"."incoming_payments" p WHERE ${where}`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "finance"."incoming_payments" p WHERE ${where}
        ORDER BY p."serial" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    ]);
    const rows = await this.prisma.incomingPayment.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { serial: 'desc' },
      include: paymentInclude,
    });
    return {
      simulationAvailable: this.simulationAvailable,
      total: count!.total,
      page,
      pageSize,
      payments: await this.withSuggestions(rows),
    };
  }

  async detail(code: string): Promise<IncomingPayment> {
    const row = await this.prisma.incomingPayment.findUnique({
      where: { code },
      include: paymentInclude,
    });
    if (!row) throw new NotFoundException('Platba neexistuje.');
    return (await this.withSuggestions([row]))[0]!;
  }

  /** Valid invoices with a remaining amount this payment may go to (the rules of allocation). */
  async openInvoices(code: string, q?: string): Promise<PaymentOpenInvoices> {
    const payment = await this.prisma.incomingPayment.findUnique({
      where: { code },
      select: { currency: true, environment: true },
    });
    if (!payment) throw new NotFoundException('Platba neexistuje.');
    const search = q ? Prisma.sql`AND i."number" ILIKE ${`%${likeEscape(q)}%`}` : Prisma.empty;
    const testAllowed =
      payment.environment === 'PRODUCTION' ? Prisma.sql`AND i."kind" <> 'TEST'` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ number: string; remaining: string }[]>`
      SELECT i."number", r."remaining"::text AS "remaining"
      FROM "finance"."invoices" i
      CROSS JOIN LATERAL (SELECT i."total" - coalesce((SELECT sum(a."amount")
        FROM "finance"."payment_allocations" a WHERE a."invoice_id" = i."id"), 0) AS "remaining") r
      WHERE i."currency" = ${payment.currency} AND r."remaining" > 0
        AND NOT EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c WHERE c."invoice_id" = i."id")
        ${testAllowed} ${search}
      ORDER BY i."serial" DESC LIMIT ${OPEN_INVOICES_LIMIT + 1}`;
    return {
      invoices: rows.slice(0, OPEN_INVOICES_LIMIT).map((r) => ({
        number: r.number,
        remaining: new Prisma.Decimal(r.remaining).toFixed(2),
      })),
      limited: rows.length > OPEN_INVOICES_LIMIT,
    };
  }

  /** Suggestions read only invoices whose remaining amount equals one of these payments' rests. */
  private async withSuggestions(rows: PaymentRow[]): Promise<IncomingPayment[]> {
    const rests = rows
      .map((p) => p.amount.minus(sum(p.allocations)))
      .filter((r) => !r.isZero())
      .map((r) => r.toFixed(2));
    const candidates =
      rests.length === 0
        ? []
        : await this.prisma.$queryRaw<
            { number: string; currency: string; kind: string; remaining: string }[]
          >`
            SELECT i."number", i."currency", i."kind", r."remaining"::text AS "remaining"
            FROM "finance"."invoices" i
            CROSS JOIN LATERAL (SELECT i."total" - coalesce((SELECT sum(a."amount")
              FROM "finance"."payment_allocations" a WHERE a."invoice_id" = i."id"), 0) AS "remaining") r
            WHERE r."remaining" IN (${Prisma.join(rests.map((v) => Prisma.sql`${v}::numeric`))})
              AND NOT EXISTS (SELECT 1 FROM "finance"."invoice_cancellations" c WHERE c."invoice_id" = i."id")
            ORDER BY i."serial" DESC LIMIT 200`;
    return rows.map((p) => {
      const allocated = sum(p.allocations);
      const unallocated = p.amount.minus(allocated);
      return {
        code: p.code,
        source: p.source as IncomingPayment['source'],
        environment: p.environment as IncomingPayment['environment'],
        reference: p.sourceKey,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        bookedOn: p.bookedOn.toISOString().slice(0, 10),
        variableSymbol: p.variableSymbol,
        counterpartyName: p.counterpartyName,
        counterpartyAccount: p.counterpartyAccount,
        message: p.message,
        matchResult: p.matchResult as MatchResult,
        state: allocated.isZero()
          ? 'UNALLOCATED'
          : unallocated.isZero()
            ? 'ALLOCATED'
            : 'PARTIALLY_ALLOCATED',
        allocated: allocated.toFixed(2),
        unallocated: unallocated.toFixed(2),
        allocations: p.allocations.map((a) => ({
          invoiceNumber: a.invoice.number,
          paymentCode: p.code,
          amount: a.amount.toFixed(2),
          kind: a.kind as 'AUTO' | 'MANUAL',
          reason: a.reason,
          recordedAt: a.recordedAt.toISOString(),
          recordedByName: a.recordedByName,
        })),
        suggestions: unallocated.isZero()
          ? []
          : candidates
              .filter(
                (i) =>
                  i.currency === p.currency &&
                  !(i.kind === 'TEST' && p.environment === 'PRODUCTION') &&
                  new Prisma.Decimal(i.remaining).equals(unallocated),
              )
              .map((i) => i.number),
        bankChangedSinceRecorded:
          p.bankTransactionVersion !== null &&
          (p.bankTransaction?.versions[0]?.version ?? 0) > p.bankTransactionVersion,
        recordedAt: p.recordedAt.toISOString(),
        recordedByName: p.recordedByName,
      };
    });
  }

  /** A simulated statement (outside production only): each reference is recorded once, ever. */
  async simulate(req: SimulateStatementRequest, caller: FinanceCaller): Promise<PaymentLoadResult> {
    if (!this.simulationAvailable)
      throw domainError(409, 'SIMULATION_DISABLED', 'V produkci se platby nesimulují.');
    const { result } = await this.operations.run(
      'PAYMENTS_SIMULATE',
      req.requestId,
      { entries: req.entries, actorId: caller.principal.userId },
      (tx) =>
        this.load(
          tx,
          req.entries.map((e) => ({
            source: 'SIMULATION' as const,
            sourceKey: e.reference,
            environment: 'SIMULATION' as const,
            bankTransactionId: null,
            bankTransactionVersion: null,
            amount: new Prisma.Decimal(e.amount),
            currency: e.currency,
            bookedOn: e.bookedOn,
            variableSymbol: e.variableSymbol,
            counterpartyName: e.counterpartyName,
            counterpartyAccount: null,
            message: e.message,
          })),
          caller,
        ),
    );
    return result;
  }

  /**
   * Records the credit bank transactions already read from the bank (doc 041) that are not yet
   * payments — each once (its newest version when first recorded). Never calls the bank.
   */
  async importBank(requestId: string, caller: FinanceCaller): Promise<PaymentLoadResult> {
    const { result } = await this.operations.run(
      'PAYMENTS_IMPORT_BANK',
      requestId,
      { actorId: caller.principal.userId },
      async (tx) => {
        const rows = await tx.bankTransaction.findMany({
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
          orderBy: { firstSeenAt: 'asc' },
        });
        const entries: Entry[] = [];
        for (const t of rows) {
          const v = t.versions[0];
          if (!v || v.creditDebit !== 'CRDT' || v.amount.lte(0)) continue;
          const booked = v.bookingDate ?? v.valueDate;
          if (!booked) continue;
          const account =
            v.counterpartyAccountNumber && v.counterpartyBankCode
              ? `${v.counterpartyAccountPrefix ? `${v.counterpartyAccountPrefix}-` : ''}${v.counterpartyAccountNumber}/${v.counterpartyBankCode}`
              : (v.counterpartyIban ?? null);
          entries.push({
            source: 'BANK',
            sourceKey: t.id,
            environment: t.environment as Entry['environment'],
            bankTransactionId: t.id,
            bankTransactionVersion: v.version,
            amount: v.amount,
            currency: v.amountCurrency,
            bookedOn: booked.toISOString().slice(0, 10),
            variableSymbol:
              v.variableSymbol && /^\d{1,10}$/.test(v.variableSymbol)
                ? v.variableSymbol.replace(/^0+(?=\d)/, '')
                : null,
            counterpartyName: v.counterpartyName?.slice(0, 200) ?? null,
            counterpartyAccount: account?.slice(0, 60) ?? null,
            message: v.message?.slice(0, 500) ?? null,
          });
        }
        return this.load(tx, entries, caller);
      },
    );
    return result;
  }

  /** A person allocates (a part of) a payment to an invoice, with a reason. */
  async allocate(
    code: string,
    req: AllocatePaymentRequest,
    caller: FinanceCaller,
  ): Promise<IncomingPayment> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'PAYMENT_ALLOCATE',
      req.requestId,
      { code, ...req, actorId: userId },
      async (tx) => {
        const payment = await tx.incomingPayment.findUnique({ where: { code } });
        if (!payment) throw new NotFoundException('Platba neexistuje.');
        const invoice = await tx.invoice.findUnique({
          where: { number: req.invoiceNumber },
          include: { cancellation: true },
        });
        if (!invoice) throw domainError(422, 'INVOICE_NOT_FOUND', 'Faktura neexistuje.');
        await lock(tx, payment.id, invoice.id);
        const amount = new Prisma.Decimal(req.amount);
        const refuse = (c: string, m: string) => domainError(422, c, m);
        if (invoice.cancellation)
          throw refuse('INVOICE_CANCELLED', 'Zrušená faktura platbu nepřijímá.');
        if (invoice.currency !== payment.currency)
          throw refuse('CURRENCY_MISMATCH', 'Platba je v jiné měně než faktura.');
        if (invoice.kind === 'TEST' && payment.environment === 'PRODUCTION')
          throw refuse('ENVIRONMENT_MISMATCH', 'Ostrou platbu nelze přiřadit testovací faktuře.');
        const [byPayment, byInvoice] = await Promise.all([
          tx.paymentAllocation.findMany({ where: { paymentId: payment.id } }),
          tx.paymentAllocation.findMany({ where: { invoiceId: invoice.id } }),
        ]);
        if (amount.greaterThan(payment.amount.minus(sum(byPayment))))
          throw refuse('EXCEEDS_PAYMENT', 'Přiřazení přesahuje nepřiřazenou část platby.');
        if (amount.greaterThan(invoice.total.minus(sum(byInvoice))))
          throw refuse('EXCEEDS_INVOICE', 'Přiřazení přesahuje zbývající částku faktury.');
        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount,
            kind: 'MANUAL',
            reason: req.reason,
            recordedBy: userId,
            recordedByName: displayName,
            requestId: req.requestId,
          },
        });
        return { code };
      },
    );
    return (await this.page()).payments.find((p) => p.code === code)!;
  }

  /** Records new entries once each and matches them; entries recorded before are only counted. */
  private async load(tx: Tx, entries: Entry[], caller: FinanceCaller): Promise<PaymentLoadResult> {
    // One load at a time: two loads of the same statement never both record an entry.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finance:payments-load'))`;
    const result: PaymentLoadResult = {
      created: [],
      alreadyLoaded: 0,
      matched: 0,
      toReview: 0,
      changedAtBank: 0,
    };
    for (const e of [...entries].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))) {
      const known = await tx.incomingPayment.findUnique({
        where: { source_sourceKey: { source: e.source, sourceKey: e.sourceKey } },
        select: { id: true, bankTransactionVersion: true },
      });
      if (known) {
        result.alreadyLoaded += 1;
        // Changed at the bank since: reported (and shown on the payment), never applied.
        if (
          known.bankTransactionVersion !== null &&
          e.bankTransactionVersion !== null &&
          e.bankTransactionVersion > known.bankTransactionVersion
        )
          result.changedAtBank += 1;
        continue;
      }
      const match = await this.match(tx, e);
      const serial = await allocateFinanceSerial(tx, 'incoming_payment');
      const code = `PP-${String(serial).padStart(6, '0')}`;
      const payment = await tx.incomingPayment.create({
        data: {
          serial,
          code,
          source: e.source,
          sourceKey: e.sourceKey,
          environment: e.environment,
          bankTransactionId: e.bankTransactionId,
          bankTransactionVersion: e.bankTransactionVersion,
          amount: e.amount,
          currency: e.currency,
          bookedOn: new Date(`${e.bookedOn}T00:00:00.000Z`),
          variableSymbol: e.variableSymbol,
          counterpartyName: e.counterpartyName,
          counterpartyAccount: e.counterpartyAccount,
          message: e.message,
          matchResult: match.result,
          recordedBy: caller.principal.userId,
          recordedByName: caller.principal.displayName,
        },
      });
      if (match.invoiceId && match.amount) {
        await tx.paymentAllocation.create({
          data: {
            paymentId: payment.id,
            invoiceId: match.invoiceId,
            amount: match.amount,
            kind: 'AUTO',
            recordedBy: caller.principal.userId,
            recordedByName: caller.principal.displayName,
          },
        });
      }
      result.created.push(code);
      if (match.result === 'MATCHED') result.matched += 1;
      else result.toReview += 1;
    }
    return result;
  }

  /** The deterministic matching of one new entry (no guessing by amount or name). */
  private async match(
    tx: Tx,
    e: Entry,
  ): Promise<{ result: MatchResult; invoiceId?: string; amount?: Prisma.Decimal }> {
    if (!e.variableSymbol) return { result: 'NO_VARIABLE_SYMBOL' };
    const invoice = await tx.invoice.findUnique({
      where: { variableSymbol: e.variableSymbol },
      include: { cancellation: true },
    });
    if (!invoice) return { result: 'UNKNOWN_VARIABLE_SYMBOL' };
    if (invoice.cancellation) return { result: 'INVOICE_CANCELLED' };
    if (invoice.currency !== e.currency) return { result: 'CURRENCY_MISMATCH' };
    if (invoice.kind === 'TEST' && e.environment === 'PRODUCTION')
      return { result: 'ENVIRONMENT_MISMATCH' };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payments:${invoice.id}`}))`;
    const paid = sum(await tx.paymentAllocation.findMany({ where: { invoiceId: invoice.id } }));
    const remaining = invoice.total.minus(paid);
    // (decimal.js counts 0 as positive: compare explicitly.)
    if (remaining.lte(0)) return { result: 'INVOICE_ALREADY_PAID' };
    // The part beyond the invoice stays on the payment (an overpayment for a person to resolve).
    return e.amount.greaterThan(remaining)
      ? { result: 'PARTIAL_OVERPAYMENT', invoiceId: invoice.id, amount: remaining }
      : { result: 'MATCHED', invoiceId: invoice.id, amount: e.amount };
  }
}

/** The same lock order as the database trigger: the payment, then the invoice. */
async function lock(tx: Tx, paymentId: string, invoiceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${paymentId}`}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payments:${invoiceId}`}))`;
}
