import { portfolioSchema, type CommissionTermsOverviewRow, type PortfolioRow } from '@ayvo/types';
import Link from 'next/link';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { apiGet } from '@/lib/api';
import { monthCs, rateCs } from './commission-format';

const t = commissionsCs.portfolio;

function rateCell(r: PortfolioRow) {
  if (r.state === 'INITIAL' || r.state === 'MAINTENANCE')
    return r.rate ? `${rateCs(r.rate)} % (${t.state[r.state]})` : t.state[r.state];
  return <span className="text-amber-800">{t.state[r.state]}</span>;
}

/**
 * Obchod → Provize → Portfolio (doc 068 §12.2; PR 1b). A salesperson sees their own hotels of
 * the month; a manager everyone, a count per salesperson, and one person on request. No amount,
 * invoice or payment state: those come from Finance (PR 2/3).
 */
export async function CommissionPortfolio({
  month,
  salesperson,
  manage,
  people,
}: {
  month: string;
  salesperson?: string;
  manage: boolean;
  people: CommissionTermsOverviewRow['salesperson'][];
}) {
  const data = await apiGet(
    'admin/sales/portfolio',
    portfolioSchema,
    manage && salesperson ? { month, salesperson } : { month },
  );
  const showPerson = manage && !salesperson;
  return (
    <div className="flex flex-col gap-4">
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="portfolio-filter">
        <input type="hidden" name="tab" value="portfolio" />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t.month}</span>
          <input
            type="month"
            name="month"
            defaultValue={month}
            className="rounded-md border border-stone-300 px-3 py-2"
            data-testid="portfolio-month"
          />
        </label>
        {manage && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t.salesperson}</span>
            <select
              name="salesperson"
              defaultValue={salesperson ?? ''}
              className="rounded-md border border-stone-300 px-3 py-2"
              data-testid="portfolio-salesperson"
            >
              <option value="">{t.everyone}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={buttonClass.secondary}>
          {t.show}
        </button>
      </form>
      <Card title={`${commissionsCs.tabs.portfolio} — ${monthCs(data.month)}`} testId="portfolio">
        <p className="mb-1 text-sm font-medium" data-testid="portfolio-count">
          {t.count(data.rows.length)}
        </p>
        <p className="mb-3 text-xs text-stone-500">{t.noAmounts}</p>
        {data.rows.length === 0 ? (
          <EmptyState>{manage ? t.emptyAll : t.empty}</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100 text-sm" data-testid="portfolio-rows">
            {data.rows.map((r) => (
              <li key={r.hotel.code} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 grow basis-48">
                  {manage ? (
                    <Link
                      href={`/hotels/${r.hotel.code}#provize`}
                      className="font-medium underline"
                    >
                      {r.hotel.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.hotel.name}</span>
                  )}
                  <span className="block text-xs text-stone-500">
                    {r.hotel.code} · {r.hotel.city}
                    {showPerson && ` · ${r.salesperson?.name ?? t.state.NO_SALESPERSON}`}
                  </span>
                </span>
                <span className="text-stone-600">
                  {t.columns.since} {monthCs(r.since)}
                </span>
                <span className="tabular-nums">
                  {t.columns.k} {t.k(r.k)}
                </span>
                <span>{rateCell(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data.totals && showPerson && data.totals.length > 0 && (
        <Card title={t.totals} testId="portfolio-totals">
          <ul className="text-sm">
            {data.totals.map((x) => (
              <li key={x.salesperson?.id ?? 'nobody'} className="flex justify-between py-1">
                <span>{x.salesperson?.name ?? t.state.NO_SALESPERSON}</span>
                <span className="tabular-nums">{x.hotels}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
