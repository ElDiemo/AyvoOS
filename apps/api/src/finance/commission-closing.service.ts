import { Injectable } from '@nestjs/common';
import type {
  ApproveCommissionStatement,
  CommissionMine,
  CommissionMode,
  CommissionPreview,
  CommissionPreviewQuery,
  CommissionStatement,
  CommissionStatementList,
  CommissionStatementsQuery,
  FinanceCommissionHotel,
} from '@ayvo/types';
import { domainError, idempotencyConflict } from '../common/domain-error.js';
import { payloadHash } from '../database/operation-requests.service.js';
import type { Prisma } from '../generated/finance-prisma/client.js';
import {
  LIVE_INVOICE_KINDS,
  closedBy,
  computeClosing,
  linesToEvaluate,
  money,
  monthNotClosed,
  cents,
  type BookedItem,
  type ClosingLine,
  type ComputedStatement,
  type LatestStatement,
} from './commission-closing.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

const toMonth = (d: Date) => d.toISOString().slice(0, 7);
const monthDate = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
/** Today in Prague (O12: a month closes at midnight of the 1st, Europe/Prague). */
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
const lineKey = (l: { invoiceId: string; lineNo: number }) => `${l.invoiceId}#${l.lineNo}`;

type Db = Prisma.TransactionClient;
type Answers = Map<string, Map<string, FinanceCommissionHotel>>;
/** Finance's own part of the sources (doc 069 §2): lines, booked items, latest statements. */
interface FinanceSources {
  lines: ClosingLine[];
  booked: BookedItem[];
  latest: (salespersonId: string, currency: string) => LatestStatement | null;
}

const APPROVE = 'COMMISSION_STATEMENT_APPROVE';

const stale = () =>
  domainError(
    409,
    'STATEMENT_STALE',
    'Podklady se od náhledu změnily. Načtěte náhled znovu a schvalte aktuální podklad.',
  );
const alreadyApproved = () =>
  domainError(409, 'ALREADY_APPROVED', 'Podklad obchodníka za tento měsíc je už schválený.');
const periodOrder = () =>
  domainError(
    409,
    'PERIOD_ORDER',
    'Obchodník už má schválený podklad za pozdější měsíc. Podklady se schvalují po měsících.',
  );

/**
 * The Finance commission closing (doc 069 §5). It reads Finance's own invoice lines,
 * cancellations and approved items and the core contract (§4); the hotel's payment is never
 * read. PR 2b: the preview; PR 2c: approving one salesperson (§5d) and the salesperson's view.
 */
@Injectable()
export class CommissionClosingService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly core: CoreClient,
    private readonly operations: FinanceOperations,
  ) {}

  /** Finance's part, read in one statement snapshot or inside the approving transaction. */
  private async readFinance(tx: Db, month: string, mode: CommissionMode): Promise<FinanceSources> {
    const kinds = mode === 'TEST' ? ['TEST'] : [...LIVE_INVOICE_KINDS];
    const rows = await tx.invoiceLine.findMany({
      where: { periodMonth: { lte: monthDate(month) }, invoice: { kind: { in: kinds } } },
      select: {
        invoiceId: true,
        lineNo: true,
        periodMonth: true,
        hotelId: true,
        hotelCode: true,
        amount: true,
        invoice: {
          select: {
            kind: true,
            number: true,
            currency: true,
            cancellation: { select: { invoiceId: true } },
          },
        },
      },
    });
    const items = await tx.commissionStatementItem.findMany({
      where: { mode },
      include: { statement: { select: { periodMonth: true, salespersonName: true } } },
      orderBy: [{ statementId: 'asc' }, { itemNo: 'asc' }],
    });
    const statements = await tx.commissionStatement.findMany({
      where: { mode },
      select: {
        id: true,
        periodMonth: true,
        salespersonId: true,
        currency: true,
        carriedForward: true,
      },
      orderBy: { periodMonth: 'desc' },
    });
    const latestBy = new Map<string, LatestStatement>();
    for (const s of statements) {
      const key = `${s.salespersonId}|${s.currency}`;
      if (!latestBy.has(key))
        latestBy.set(key, {
          id: s.id,
          periodMonth: toMonth(s.periodMonth),
          carriedForward: cents(s.carriedForward.toFixed(2)),
        });
    }
    return {
      lines: rows.map((l) => ({
        invoiceId: l.invoiceId,
        invoiceNumber: l.invoice.number,
        invoiceKind: l.invoice.kind,
        currency: l.invoice.currency,
        lineNo: l.lineNo,
        periodMonth: toMonth(l.periodMonth),
        hotelId: l.hotelId,
        hotelCode: l.hotelCode,
        amount: l.amount.toFixed(2),
        cancelled: l.invoice.cancellation !== null,
      })),
      booked: items.map((i) => ({
        statementPeriod: toMonth(i.statement.periodMonth),
        salespersonId: i.salespersonId,
        salespersonName: i.statement.salespersonName,
        kind: i.kind as BookedItem['kind'],
        cause: i.cause,
        invoiceId: i.invoiceId,
        lineNo: i.lineNo,
        base: cents(i.base.toFixed(2)),
        rate: i.rate.toFixed(2),
        k: i.k,
        amount: cents(i.amount.toFixed(2)),
        attributionRevision: i.attributionRevision,
        bindingId: i.bindingId,
        termsVersion: i.termsVersion,
      })),
      latest: (sp, currency) => latestBy.get(`${sp}|${currency}`) ?? null,
    };
  }

  /**
   * The core contract once per billed month involved, in sorted batches (doc 069 §4); any
   * failure is 503 before anything is computed or written.
   */
  private async answersFor(lines: readonly ClosingLine[], caller: FinanceCaller): Promise<Answers> {
    const byPeriod = new Map<string, Set<string>>();
    for (const l of lines)
      byPeriod.set(l.periodMonth, (byPeriod.get(l.periodMonth) ?? new Set()).add(l.hotelId));
    const answers: Answers = new Map();
    for (const [period, ids] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)))
      answers.set(
        period,
        await this.core.commissionAttributions(caller.sessionToken, period, [...ids]),
      );
    return answers;
  }

  /** Finance's snapshot + the core: everything due in M (no write). */
  private async compute(month: string, mode: CommissionMode, caller: FinanceCaller) {
    const sources = await this.prisma.$transaction((tx) => this.readFinance(tx, month, mode), {
      isolationLevel: 'RepeatableRead',
    });
    const evaluated = linesToEvaluate(month, mode, sources.lines, sources.booked);
    const answers = await this.answersFor(evaluated, caller);
    return {
      evaluated,
      answers,
      result: computeClosing({ month, mode, ...sources, lines: evaluated, answers }),
    };
  }

  async preview(q: CommissionPreviewQuery, caller: FinanceCaller): Promise<CommissionPreview> {
    if (!closedBy(q.month, pragueToday())) throw monthNotClosed();
    const { result: r } = await this.compute(q.month, q.mode, caller);
    return {
      month: q.month,
      mode: q.mode,
      statements: r.statements.map((s) => ({
        salesperson: { id: s.salespersonId, name: s.salespersonName },
        currency: s.currency,
        previousPeriod: s.previous?.periodMonth ?? null,
        openingBalance: money(s.opening),
        total: money(s.total),
        closingBalance: money(s.closing),
        amountToInvoice: money(s.amountToInvoice),
        carriedForward: money(s.carriedForward),
        items: s.items.map((i) => ({
          kind: i.kind,
          cause: i.cause,
          invoiceNumber: i.invoiceNumber,
          lineNo: i.lineNo,
          hotelCode: i.hotelCode,
          serviceMonth: i.serviceMonth,
          base: money(i.base),
          k: i.k,
          rate: i.rate,
          amount: money(i.amount),
          attributionRevision: i.attributionRevision,
          termsVersion: i.termsVersion,
        })),
        flags: s.flags,
        fingerprint: s.fingerprint,
      })),
      unresolved: r.unresolved,
    };
  }

  /** §5d step 2 (Finance only): one statement per month, strictly in order. */
  private async assertOrder(db: Db, req: ApproveCommissionStatement): Promise<void> {
    const latest = await db.commissionStatement.findFirst({
      where: { salespersonId: req.salespersonId, currency: req.currency, mode: req.mode },
      orderBy: { periodMonth: 'desc' },
      select: { periodMonth: true },
    });
    if (!latest) return;
    const at = toMonth(latest.periodMonth);
    if (at === req.month) throw alreadyApproved();
    if (at > req.month) {
      const same = await db.commissionStatement.findUnique({
        where: {
          periodMonth_salespersonId_currency_mode: {
            periodMonth: monthDate(req.month),
            salespersonId: req.salespersonId,
            currency: req.currency,
            mode: req.mode,
          },
        },
        select: { id: true },
      });
      throw same ? alreadyApproved() : periodOrder();
    }
  }

  /**
   * Approves one salesperson's statement of M exactly as previewed (doc 069 §5d). The order:
   * permission (guard) → replay → order → the core read outside any transaction → one Finance
   * transaction under `commission:<mode>:<salesperson>` that re-checks Finance's part and writes
   * the statement, its items and APPROVED. Never changed afterwards.
   */
  async approve(
    req: ApproveCommissionStatement,
    caller: FinanceCaller,
  ): Promise<CommissionStatement> {
    const { userId, displayName } = caller.principal;
    const payload = {
      month: req.month,
      salespersonId: req.salespersonId,
      currency: req.currency,
      mode: req.mode,
      fingerprint: req.fingerprint,
      actorId: userId,
    };
    // 1. Replay — the same actor and content get the stored result without reading the core.
    const prior = await this.prisma.operationRequest.findUnique({
      where: { requestId: req.requestId },
    });
    if (prior) {
      const stored = prior.result as { statementId?: string } | null;
      if (prior.kind !== APPROVE || prior.payloadSha256 !== payloadHash(APPROVE, payload))
        throw idempotencyConflict();
      if (!stored?.statementId) throw idempotencyConflict();
      return this.statement(stored.statementId);
    }
    // 2. Order (Finance only).
    if (!closedBy(req.month, pragueToday())) throw monthNotClosed();
    await this.assertOrder(this.prisma, req);

    // 3. The core, outside any transaction (503 → nothing written); the confirmed fingerprint.
    const sourcesReadAt = new Date();
    const { evaluated, answers, result } = await this.compute(req.month, req.mode, caller);
    const mine = (r: { statements: ComputedStatement[] }) =>
      r.statements.find(
        (s) => s.salespersonId === req.salespersonId && s.currency === req.currency,
      ) ?? null;
    const s = mine(result);
    if (!s) throw domainError(422, 'NOTHING_TO_APPROVE', 'Obchodník nemá za tento měsíc podklad.');
    if (s.fingerprint !== req.fingerprint) throw stale();
    if (s.flags.length > 0)
      throw domainError(
        422,
        'STATEMENT_FLAGGED',
        'Podklad obsahuje nevyřešené řádky. Nejprve je vyřešte, pak podklad schvalte.',
      );
    if (s.items.length === 0)
      throw domainError(422, 'NOTHING_TO_APPROVE', 'Obchodník nemá za tento měsíc podklad.');
    const read = new Set(evaluated.map(lineKey));

    // 4. One Finance transaction under the salesperson's lock.
    const { result: done } = await this.operations
      .run(APPROVE, req.requestId, payload, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission:${req.mode}:${req.salespersonId}`}, 0))`;
        await this.assertOrder(tx, req);
        // Finance's part again (latest statement, booked items, cancellations of the lines read)
        // with the same core answer: a difference is STATEMENT_STALE. A line issued after the
        // core read is not part of this statement; its due month is the next one (§5d).
        const again = await this.readFinance(tx, req.month, req.mode);
        const now = mine(
          computeClosing({
            month: req.month,
            mode: req.mode,
            ...again,
            lines: again.lines.filter((l) => read.has(lineKey(l))),
            answers,
          }),
        );
        if (!now || now.fingerprint !== req.fingerprint || now.flags.length > 0) throw stale();
        const created = await tx.commissionStatement.create({
          data: {
            periodMonth: monthDate(req.month),
            salespersonId: now.salespersonId,
            salespersonName: now.salespersonName,
            currency: now.currency,
            mode: req.mode,
            previousStatementId: now.previous?.id ?? null,
            openingBalance: money(now.opening),
            total: money(now.total),
            closingBalance: money(now.closing),
            amountToInvoice: money(now.amountToInvoice),
            carriedForward: money(now.carriedForward),
            fingerprint: now.fingerprint,
            sourcesReadAt,
            approvedBy: userId,
            approvedByName: displayName,
            requestId: req.requestId,
          },
          select: { id: true },
        });
        // One by one, in the statement's order: the item trigger serialises with a cancellation
        // of the same invoice (shared key), in a fixed order across approvals.
        let no = 0;
        for (const i of now.items)
          await tx.commissionStatementItem.create({
            data: {
              statementId: created.id,
              itemNo: ++no,
              mode: req.mode,
              salespersonId: now.salespersonId,
              kind: i.kind,
              cause: i.cause,
              invoiceId: i.invoiceId,
              lineNo: i.lineNo,
              invoiceNumber: i.invoiceNumber,
              serviceMonth: monthDate(i.serviceMonth),
              hotelId: i.hotelId,
              hotelCode: i.hotelCode,
              base: money(i.base),
              attributionRevision: i.attributionRevision,
              bindingId: i.bindingId,
              termsVersion: i.termsVersion,
              k: i.k,
              rate: i.rate,
              amount: money(i.amount),
            },
          });
        await tx.commissionStatementEvent.create({
          data: {
            statementId: created.id,
            kind: 'APPROVED',
            recordedBy: userId,
            recordedByName: displayName,
          },
        });
        return { statementId: created.id };
      })
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e);
        if (/commission_statements_slot_key/.test(text)) throw alreadyApproved();
        // A concurrent cancellation, approval or correction got there first (DB invariants).
        if (
          /AYVO: (a regular commission item|a storno item|a commission statement (follows|is never)|the opening balance|the first commission statement)|commission_statement_items_(regular|cause)_key|commission_statements_(previous|first)_key/.test(
            text,
          )
        )
          throw stale();
        throw e;
      });
    return this.statement(done.statementId);
  }

  private async statement(id: string): Promise<CommissionStatement> {
    const s = await this.prisma.commissionStatement.findUniqueOrThrow({
      where: { id },
      include: {
        items: { orderBy: { itemNo: 'asc' } },
        previous: { select: { periodMonth: true } },
      },
    });
    return toStatement(s);
  }

  /** The approved statements of a month (finance:commissions_manage). */
  async list(q: CommissionStatementsQuery): Promise<CommissionStatementList> {
    const rows = await this.prisma.commissionStatement.findMany({
      where: { periodMonth: monthDate(q.month), mode: q.mode },
      include: {
        items: { orderBy: { itemNo: 'asc' } },
        previous: { select: { periodMonth: true } },
      },
      orderBy: [{ salespersonName: 'asc' }, { salespersonId: 'asc' }],
    });
    return { month: q.month, mode: q.mode, statements: rows.map(toStatement) };
  }

  /**
   * The salesperson's own view (sales:work, doc 069 §5d): the caller's approved statement of M —
   * the state and one amount; nothing about hotels, invoices, payments or other people.
   */
  async mine(q: CommissionStatementsQuery, caller: FinanceCaller): Promise<CommissionMine> {
    const s = await this.prisma.commissionStatement.findUnique({
      where: {
        periodMonth_salespersonId_currency_mode: {
          periodMonth: monthDate(q.month),
          salespersonId: caller.principal.userId,
          currency: 'CZK',
          mode: q.mode,
        },
      },
      select: { currency: true, amountToInvoice: true, carriedForward: true, approvedAt: true },
    });
    if (!s)
      return {
        month: q.month,
        mode: q.mode,
        state: 'PROCESSING',
        currency: null,
        amountToInvoice: null,
        balanceCarriedForward: null,
        approvedAt: null,
      };
    const positive = s.amountToInvoice.gt(0);
    return {
      month: q.month,
      mode: q.mode,
      state: positive ? 'TO_INVOICE' : 'NOTHING_TO_INVOICE',
      currency: s.currency,
      amountToInvoice: positive ? s.amountToInvoice.toFixed(2) : null,
      balanceCarriedForward: positive ? null : s.carriedForward.toFixed(2),
      approvedAt: s.approvedAt.toISOString(),
    };
  }
}

type StatementRow = Prisma.CommissionStatementGetPayload<{
  include: { items: true; previous: { select: { periodMonth: true } } };
}>;
function toStatement(s: StatementRow): CommissionStatement {
  return {
    id: s.id,
    month: toMonth(s.periodMonth),
    mode: s.mode as CommissionMode,
    salesperson: { id: s.salespersonId, name: s.salespersonName },
    currency: s.currency,
    previousPeriod: s.previous ? toMonth(s.previous.periodMonth) : null,
    openingBalance: s.openingBalance.toFixed(2),
    total: s.total.toFixed(2),
    closingBalance: s.closingBalance.toFixed(2),
    amountToInvoice: s.amountToInvoice.toFixed(2),
    carriedForward: s.carriedForward.toFixed(2),
    items: s.items.map((i) => ({
      kind: i.kind as 'REGULAR' | 'CORRECTION',
      cause: i.cause,
      invoiceNumber: i.invoiceNumber,
      lineNo: i.lineNo,
      hotelCode: i.hotelCode,
      serviceMonth: toMonth(i.serviceMonth),
      base: i.base.toFixed(2),
      k: i.k,
      rate: i.rate.toFixed(2),
      amount: i.amount.toFixed(2),
      attributionRevision: i.attributionRevision,
      termsVersion: i.termsVersion,
    })),
    fingerprint: s.fingerprint,
    sourcesReadAt: s.sourcesReadAt.toISOString(),
    approvedAt: s.approvedAt.toISOString(),
    approvedByName: s.approvedByName,
  };
}
