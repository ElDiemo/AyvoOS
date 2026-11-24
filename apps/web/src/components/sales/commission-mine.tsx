import { commissionMineSchema, portfolioSchema } from '@ayvo/types';
import Link from 'next/link';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { buttonClass, Card, ErrorNote, Field, FieldList } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGetPanel, apiGetResult } from '@/lib/api';
import { earliestPayout, pragueMonth } from './commission-closing-format';
import { monthCs } from './commission-format';

const t = commissionsCs.statement;

/**
 * Obchod → Provize → Moje provize (sales:work; doc 069 §5d "Salesperson view"): the state of the
 * caller's own statement of the chosen closed month with exactly one instruction; the amount to
 * invoice only before the invoice is recorded, afterwards the same amount labelled as invoiced and
 * the payout day as a plan. Separately, today's count of hotels from the existing portfolio — not
 * the statement's. Never another person, a hotel's invoice or a payment; there is no "Vyplaceno".
 */
export async function CommissionMine({ month }: { month: string }) {
  const now = pragueMonth();
  const [mine, portfolio] = await Promise.all([
    apiGetResult('admin/finance/commissions/mine', commissionMineSchema, { month, mode: 'TEST' }),
    apiGetPanel('admin/sales/portfolio', portfolioSchema, { month: now }),
  ]);
  const label = monthCs(month);

  let body: React.ReactNode;
  if (!mine.ok) body = <ErrorNote>{t.unavailable}</ErrorNote>;
  else {
    const m = mine.data;
    const amount = m.amountToInvoice ? financeAmount(m.amountToInvoice, m.currency ?? 'CZK') : null;
    const instruction =
      m.state === 'PROCESSING'
        ? t.instruction.PROCESSING(label)
        : m.state === 'TO_INVOICE'
          ? t.instruction.TO_INVOICE(amount ?? '—')
          : m.state === 'NOTHING_TO_INVOICE'
            ? t.instruction.NOTHING_TO_INVOICE
            : t.instruction.INVOICE_RECEIVED;
    body = (
      <>
        <p className="text-lg font-semibold" data-testid="mine-state">
          {t.state[m.state]}
        </p>
        <p className="text-base font-medium text-stone-900" data-testid="mine-instruction">
          {instruction}
        </p>
        <FieldList>
          {m.state === 'TO_INVOICE' && amount && (
            <Field label={t.amount}>
              <strong className="text-lg" data-testid="mine-amount">
                {amount}
              </strong>
            </Field>
          )}
          {m.state === 'INVOICE_RECEIVED' && amount && (
            <Field label={t.invoiced}>
              <span data-testid="mine-invoiced">{amount}</span>
            </Field>
          )}
          {m.balanceCarriedForward !== null && (
            <Field label={t.carried}>
              {financeAmount(m.balanceCarriedForward, m.currency ?? 'CZK')}
            </Field>
          )}
          {m.approvedAt && <Field label={t.approvedAt}>{formatDateTimeCs(m.approvedAt)}</Field>}
          {m.payoutPlannedOn && (
            <Field label={t.payoutPlan}>
              <span data-testid="mine-payout">{financeDate(m.payoutPlannedOn)}</span>
            </Field>
          )}
        </FieldList>
        {m.state === 'TO_INVOICE' && (
          <p className="text-xs text-stone-500" data-testid="mine-rule">
            {t.rule(earliestPayout(month))}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="mine-filter">
        <input type="hidden" name="tab" value="statement" />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t.month}</span>
          <input
            type="month"
            name="month"
            defaultValue={month}
            className="rounded-md border border-stone-300 px-3 py-2"
            data-testid="mine-month"
          />
        </label>
        <button type="submit" className={buttonClass.secondary}>
          {t.show}
        </button>
      </form>
      <Card title={t.heading(label)} testId="mine-statement">
        <div className="flex flex-col gap-3">
          <p
            className="self-start rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900"
            data-testid="mine-test-badge"
          >
            {t.testBadge}
          </p>
          {body}
        </div>
      </Card>
      <Card title={t.portfolioHeading} testId="mine-portfolio">
        <div className="flex flex-col gap-2 text-sm">
          {portfolio.state === 'ok' ? (
            <p data-testid="mine-hotels-now">
              {t.portfolioNow(portfolio.data.rows.length, monthCs(now))}
            </p>
          ) : (
            <p className="text-stone-500" data-testid="mine-hotels-unavailable">
              {t.hotelsUnavailable}
            </p>
          )}
          <p className="text-xs text-stone-500">{t.portfolioNote(label)}</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link
              href={`/sales/commissions?tab=portfolio&month=${now}`}
              className="text-stone-700 underline underline-offset-2 hover:text-stone-900"
              data-testid="mine-portfolio-link"
            >
              {t.portfolioLink}
            </Link>
            <Link
              href="/sales/commissions?tab=mine"
              className="text-stone-700 underline underline-offset-2 hover:text-stone-900"
              data-testid="mine-terms-link"
            >
              {t.termsLink}
            </Link>
          </p>
        </div>
      </Card>
    </div>
  );
}
