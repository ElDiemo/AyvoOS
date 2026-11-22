import { commissionMineSchema, portfolioSchema } from '@ayvo/types';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { buttonClass, Card, ErrorNote, Field, FieldList } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGetPanel, apiGetResult } from '@/lib/api';
import { earliestPayout } from './commission-closing-format';
import { monthCs } from './commission-format';

const t = commissionsCs.statement;

/**
 * Obchod → Provize → Můj podklad (sales:work; doc 069 §5d "Salesperson view", PR 2e): the state of
 * the caller's own statement, the hotels attributed to them in the month (the portfolio), the one
 * amount to invoice and the dates Finance returns. Never another person, a hotel's invoice or a
 * payment; there is no "Vyplaceno" — no source records a payout yet.
 */
export async function CommissionMine({ month }: { month: string }) {
  const [mine, portfolio] = await Promise.all([
    apiGetResult('admin/finance/commissions/mine', commissionMineSchema, { month, mode: 'TEST' }),
    apiGetPanel('admin/sales/portfolio', portfolioSchema, { month }),
  ]);
  const label = monthCs(month);

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
          {mine.ok ? (
            <>
              <p className="text-lg font-semibold" data-testid="mine-state">
                {t.state[mine.data.state]}
              </p>
              <p className="text-sm text-stone-600">{t.help[mine.data.state]}</p>
              <FieldList>
                <Field label={t.hotels}>
                  {portfolio.state === 'ok' ? (
                    <span data-testid="mine-hotels">{portfolio.data.rows.length}</span>
                  ) : (
                    <span className="text-stone-500">{t.hotelsUnavailable}</span>
                  )}
                </Field>
                {mine.data.amountToInvoice !== null && (
                  <Field label={t.amount}>
                    <strong className="text-lg" data-testid="mine-amount">
                      {financeAmount(mine.data.amountToInvoice, mine.data.currency)}
                    </strong>
                  </Field>
                )}
                {mine.data.balanceCarriedForward !== null && (
                  <Field label={t.carried}>
                    {financeAmount(mine.data.balanceCarriedForward, mine.data.currency)}
                  </Field>
                )}
                {mine.data.approvedAt && (
                  <Field label={t.approvedAt}>{formatDateTimeCs(mine.data.approvedAt)}</Field>
                )}
                {mine.data.payoutPlannedOn && (
                  <Field label={t.payoutPlanned}>
                    <strong data-testid="mine-payout">
                      {financeDate(mine.data.payoutPlannedOn)}
                    </strong>
                  </Field>
                )}
              </FieldList>
              <p className="text-xs text-stone-500">{t.hotelsNote}</p>
              {mine.data.state === 'TO_INVOICE' && (
                <p className="text-sm" data-testid="mine-rule">
                  {t.rule(earliestPayout(month))}
                </p>
              )}
            </>
          ) : (
            <ErrorNote>{t.unavailable}</ErrorNote>
          )}
        </div>
      </Card>
    </div>
  );
}
