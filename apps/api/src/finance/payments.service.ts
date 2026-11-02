import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENTS_DEFAULT_PAGE_SIZE } from '@ayvo/types';
import type {
  BankPaymentCandidate,
  PaymentOpenInvoices,
  PaymentsQuery,
  AllocatePaymentRequest,
  AllocateBankTransactionRequest,
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
interface Match {
  result: MatchResult;
  invoiceId?: string;
  amount?: Prisma.Decimal;
}

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

/**
 * Results whose variable symbol names exactly one invoice of an allowed environment: the payment of
 * a hotel invoice (owner 2026-11-02). A bank transaction without one is not recorded as a payment
 * at all — it stays in Bankovní pohyby, where a person may still allocate it to an invoice.
 */
const INVOICE_PAYMENT_RESULTS: readonly MatchResult[] = [
  'MATCHED',
  'PARTIAL_OVERPAYMENT',
  'INVOICE_ALREADY_PAID',
  'INVOICE_CANCELLED',
  'CURRENCY_MISMATCH',
  'PAID_BEFORE_ISSUE',
];

/**
 * A hotel invoice's payment: allocated to an invoice (automatically or by a person) or naming one
 * by its exact VS. Only these are reviewed — a payment recorded earlier from any other income
 * (before 2026-11-02, or a simulated one) stays listed and allocatable, never a task.
 */
const invoicePaymentSql = Prisma.sql`(EXISTS (SELECT 1 FROM "finance"."payment_allocations" a
    WHERE a."payment_id" = p."id")
  OR p."match_result" IN (${Prisma.join(INVOICE_PAYMENT_RESULTS)}))`;
const allocatedSql = Prisma.sql`coalesce((SELECT sum(a."amount") FROM "finance"."payment_allocations" a WHERE a."payment_id" = p."id"), 0)`;

/** To review (the overview's count and the list's REVIEW): an invoice payment's unallocated rest. */
export const paymentToReviewSql = Prisma.sql`${invoicePaymentSql} AND p."amount" > ${allocatedSql}`;
/** An invoice payment the bank changed after it was recorded (never applied; counted apart). */
export const paymentChangedAtBankSql = Prisma.sql`${invoicePaymentSql}
  AND p."bank_transaction_version" IS NOT NULL
  AND (SELECT max(v."version") FROM "finance"."bank_transaction_versions" v
       WHERE v."transaction_id" = p."bank_transaction_id") > p."bank_transaction_version"`;

/** The list's filters; REVIEW and CHANGED are the same conditions as the overview's counts. */
function paymentsWhere(query: PaymentsQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.filter === 'REVIEW') parts.push(paymentToReviewSql);
  if (query.filter === 'ALLOCATED') parts.push(Prisma.sql`p."amount" = ${allocatedSql}`);
  if (query.filter === 'CHANGED') parts.push(paymentChangedAtBankSql);
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
 * Incoming payments of hotel invoices (N3B-2, doc 041 §8; scope owner 2026-11-02): recorded once
 * per source entry (a credit bank transaction already read whose VS names an invoice, or a
 * simulated statement entry outside production), matched deterministically — automatically only on
 * an exact variable symbol of one open invoice in the same currency and an allowed environment —
 * and otherwise left for a person with the reason. A person allocates with a reason, also an
 * incoming bank transaction never recorded (a hotel's wrong VS). Other income is never a task. Nothing is ever sent to a bank; the database refuses any
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
    return this.openInvoicesFor(payment, q);
  }

  /**
   * An incoming bank transaction a person may allocate to an invoice (a hotel paid with a wrong VS):
   * its facts, the payment already recorded from it (then that one is used — never a second) and
   * the invoices it may go to.
   */
  async bankCandidate(transactionId: string, q?: string): Promise<BankPaymentCandidate> {
    const t = await this.prisma.bankTransaction.findUnique({
      where: { id: transactionId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const entry = t && bankEntry(t);
    if (!entry) throw new NotFoundException('Příchozí bankovní pohyb neexistuje.');
    const recorded = await this.prisma.incomingPayment.findUnique({
      where: { source_sourceKey: { source: 'BANK', sourceKey: entry.sourceKey } },
      select: { code: true },
    });
    return {
      transactionId: entry.sourceKey,
      environment: entry.environment,
      amount: entry.amount.toFixed(2),
      currency: entry.currency,
      bookedOn: entry.bookedOn,
      variableSymbol: entry.variableSymbol,
      counterpartyName: entry.counterpartyName,
      counterpartyAccount: entry.counterpartyAccount,
      message: entry.message,
      paymentCode: recorded?.code ?? null,
      ...(recorded ? { invoices: [], limited: false } : await this.openInvoicesFor(entry, q)),
    };
  }

  private async openInvoicesFor(
    payment: { currency: string; environment: string },
    q?: string,
  ): Promise<PaymentOpenInvoices> {
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
      // The same rule as paymentToReviewSql.
      const invoicePayment =
        p.allocations.length > 0 || INVOICE_PAYMENT_RESULTS.includes(p.matchResult as MatchResult);
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
        toReview: invoicePayment && !unallocated.isZero(),
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
          { invoicePaymentsOnly: false },
        ),
    );
    return result;
  }

  /**
   * Records, from the credit bank transactions already read (doc 041), the payments of hotel
   * invoices — a VS naming exactly one invoice (owner 2026-11-02) — each once (its newest version
   * when first recorded). Any other income is not recorded: it stays in Bankovní pohyby, no task,
   * and a person may still allocate it to an invoice (allocateBankTransaction). Never calls the bank.
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
        const entries = rows.map(bankEntry).filter((e): e is Entry => e !== null);
        return this.load(tx, entries, caller, { invoicePaymentsOnly: true });
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
    await this.operations.run(
      'PAYMENT_ALLOCATE',
      req.requestId,
      { code, ...req, actorId: caller.principal.userId },
      async (tx) => {
        const payment = await tx.incomingPayment.findUnique({ where: { code } });
        if (!payment) throw new NotFoundException('Platba neexistuje.');
        await this.allocateTo(tx, payment, req, caller);
        return { code };
      },
    );
    return this.detail(code);
  }

  /**
   * A person allocates an incoming bank transaction to an invoice (a hotel paid with a wrong VS), in
   * one transaction: the payment recorded from it before is used (never a second one), otherwise it
   * is recorded now — with the newest version, the caller and the reason as any other — and kept
   * only if the allocation succeeds. A transaction naming an invoice by its VS is recorded by the
   * import first (with its automatic allocation), then allocated on the payment.
   */
  async allocateBankTransaction(
    transactionId: string,
    req: AllocateBankTransactionRequest,
    caller: FinanceCaller,
  ): Promise<IncomingPayment> {
    const { result } = await this.operations.run(
      'PAYMENT_ALLOCATE',
      req.requestId,
      { bankTransactionId: transactionId, ...req, actorId: caller.principal.userId },
      async (tx) => {
        // The same lock as a load: an import or another person never records it at the same time.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finance:payments-load'))`;
        let payment = await tx.incomingPayment.findUnique({
          where: { source_sourceKey: { source: 'BANK', sourceKey: transactionId } },
        });
        if (!payment) {
          const t = await tx.bankTransaction.findUnique({
            where: { id: transactionId },
            include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
          });
          const entry = t && bankEntry(t);
          if (!entry) throw new NotFoundException('Příchozí bankovní pohyb neexistuje.');
          const match = await this.match(tx, entry);
          if (INVOICE_PAYMENT_RESULTS.includes(match.result))
            throw domainError(
              409,
              'IMPORT_FIRST',
              'Pohyb nese variabilní symbol faktury: nejdřív načtěte platby z bankovních pohybů.',
            );
          payment = await this.record(tx, entry, match, caller);
        }
        await this.allocateTo(tx, payment, req, caller);
        return { code: payment.code };
      },
    );
    return this.detail(result.code);
  }

  /** The checks and the MANUAL allocation, inside the caller's transaction. */
  private async allocateTo(
    tx: Tx,
    payment: { id: string; amount: Prisma.Decimal; currency: string; environment: string },
    req: AllocatePaymentRequest,
    caller: FinanceCaller,
  ): Promise<void> {
    const { userId, displayName } = caller.principal;
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
  }

  /**
   * Records new entries once each and matches them; entries recorded before are only counted. From
   * the bank only invoice payments are recorded; a simulated statement records every entry (a person
   * typed each one), but only an invoice payment's rest is to review.
   */
  private async load(
    tx: Tx,
    entries: Entry[],
    caller: FinanceCaller,
    { invoicePaymentsOnly }: { invoicePaymentsOnly: boolean },
  ): Promise<PaymentLoadResult> {
    // One load at a time: two loads of the same statement never both record an entry.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finance:payments-load'))`;
    const result: Required<PaymentLoadResult> = {
      created: [],
      alreadyLoaded: 0,
      matched: 0,
      toReview: 0,
      otherIncome: 0,
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
      const invoicePayment = INVOICE_PAYMENT_RESULTS.includes(match.result);
      if (!invoicePayment) {
        result.otherIncome += 1;
        if (invoicePaymentsOnly) continue;
      }
      const payment = await this.record(tx, e, match, caller);
      result.created.push(payment.code);
      if (match.result === 'MATCHED') result.matched += 1;
      else if (invoicePayment) result.toReview += 1;
    }
    return result;
  }

  /** Records one entry as a payment, with its automatic allocation when it matched an invoice. */
  private async record(tx: Tx, e: Entry, match: Match, caller: FinanceCaller) {
    const serial = await allocateFinanceSerial(tx, 'incoming_payment');
    const payment = await tx.incomingPayment.create({
      data: {
        serial,
        code: `PP-${String(serial).padStart(6, '0')}`,
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
    return payment;
  }

  /** The deterministic matching of one new entry (no guessing by amount or name). */
  private async match(tx: Tx, e: Entry): Promise<Match> {
    if (!e.variableSymbol) return { result: 'NO_VARIABLE_SYMBOL' };
    const invoice = await tx.invoice.findUnique({
      where: { variableSymbol: e.variableSymbol },
      include: { cancellation: true },
    });
    if (!invoice) return { result: 'UNKNOWN_VARIABLE_SYMBOL' };
    // The environment first (review RB110-R1): a production payment naming a TEST invoice is no
    // invoice payment at all, whatever else differs — never recorded from the bank, never a task.
    if (invoice.kind === 'TEST' && e.environment === 'PRODUCTION')
      return { result: 'ENVIRONMENT_MISMATCH' };
    if (invoice.cancellation) return { result: 'INVOICE_CANCELLED' };
    if (invoice.currency !== e.currency) return { result: 'CURRENCY_MISMATCH' };
    // Money received before the invoice was issued (the tax point, doc 040 §13) is never silently
    // an ordinary later payment: a person decides.
    if (e.bookedOn < invoice.issuedOn.toISOString().slice(0, 10))
      return { result: 'PAID_BEFORE_ISSUE' };
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

type BankTransactionRow = Prisma.BankTransactionGetPayload<{
  include: { versions: true };
}>;

/** A bank transaction as an entry: only an incoming one (credit, > 0, with a date), else null. */
function bankEntry(t: BankTransactionRow): Entry | null {
  const v = t.versions[0];
  if (!v || v.creditDebit !== 'CRDT' || v.amount.lte(0)) return null;
  const booked = v.bookingDate ?? v.valueDate;
  if (!booked) return null;
  const account =
    v.counterpartyAccountNumber && v.counterpartyBankCode
      ? `${v.counterpartyAccountPrefix ? `${v.counterpartyAccountPrefix}-` : ''}${v.counterpartyAccountNumber}/${v.counterpartyBankCode}`
      : (v.counterpartyIban ?? null);
  return {
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
  };
}

/** The same lock order as the database trigger: the payment, then the invoice. */
async function lock(tx: Tx, paymentId: string, invoiceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${paymentId}`}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payments:${invoiceId}`}))`;
}
