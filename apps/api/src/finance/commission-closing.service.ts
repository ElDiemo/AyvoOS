import { Injectable } from '@nestjs/common';
import type {
  CommissionPreview,
  CommissionPreviewQuery,
  FinanceCommissionHotel,
} from '@ayvo/types';
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
  type LatestStatement,
} from './commission-closing.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FinancePrismaService } from './finance-prisma.service.js';

const toMonth = (d: Date) => d.toISOString().slice(0, 7);
const monthDate = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
/** Today in Prague (O12: a month closes at midnight of the 1st, Europe/Prague). */
const pragueToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

/**
 * The Finance commission closing (doc 069 §5). PR 2b: the preview only — it reads Finance's own
 * invoice lines, cancellations and approved items and the core contract (§4), and writes nothing.
 * The hotel's payment is never read. Approval follows in PR 2c.
 */
@Injectable()
export class CommissionClosingService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly core: CoreClient,
  ) {}

  async preview(q: CommissionPreviewQuery, caller: FinanceCaller): Promise<CommissionPreview> {
    if (!closedBy(q.month, pragueToday())) throw monthNotClosed();
    const kinds = q.mode === 'TEST' ? ['TEST'] : [...LIVE_INVOICE_KINDS];
    const [lines, booked, latest] = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.invoiceLine.findMany({
          where: { periodMonth: { lte: monthDate(q.month) }, invoice: { kind: { in: kinds } } },
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
          where: { mode: q.mode },
          include: { statement: { select: { periodMonth: true, salespersonName: true } } },
          orderBy: [{ statementId: 'asc' }, { itemNo: 'asc' }],
        });
        const statements = await tx.commissionStatement.findMany({
          where: { mode: q.mode },
          select: {
            id: true,
            periodMonth: true,
            salespersonId: true,
            currency: true,
            carriedForward: true,
          },
          orderBy: { periodMonth: 'desc' },
        });
        return [rows, items, statements] as const;
      },
      { isolationLevel: 'RepeatableRead' },
    );

    const closingLines: ClosingLine[] = lines.map((l) => ({
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
    }));
    const bookedItems: BookedItem[] = booked.map((i) => ({
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
    }));
    const latestBy = new Map<string, LatestStatement>();
    for (const s of latest) {
      const key = `${s.salespersonId}|${s.currency}`;
      if (!latestBy.has(key))
        latestBy.set(key, {
          id: s.id,
          periodMonth: toMonth(s.periodMonth),
          carriedForward: cents(s.carriedForward.toFixed(2)),
        });
    }

    // The core contract once per billed month involved, in batches (doc 069 §4); any failure is
    // 503 before anything is computed.
    const evaluated = linesToEvaluate(q.month, q.mode, closingLines, bookedItems);
    const byPeriod = new Map<string, Set<string>>();
    for (const l of evaluated)
      byPeriod.set(l.periodMonth, (byPeriod.get(l.periodMonth) ?? new Set()).add(l.hotelId));
    const answers = new Map<string, Map<string, FinanceCommissionHotel>>();
    for (const [period, ids] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)))
      answers.set(
        period,
        await this.core.commissionAttributions(caller.sessionToken, period, [...ids]),
      );

    const r = computeClosing({
      month: q.month,
      mode: q.mode,
      lines: evaluated,
      booked: bookedItems,
      latest: (sp, currency) => latestBy.get(`${sp}|${currency}`) ?? null,
      answers,
    });
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
}
