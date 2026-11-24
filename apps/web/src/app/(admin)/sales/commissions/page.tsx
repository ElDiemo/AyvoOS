import {
  commissionTermsOverviewSchema,
  commissionTermsSchema,
  type CommissionTerms,
  type CommissionTermsVersion,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CommissionClosing } from '@/components/sales/commission-closing';
import { isMonth, pragueMonth, previousMonth } from '@/components/sales/commission-closing-format';
import { CommissionMine } from '@/components/sales/commission-mine';
import { CommissionPortfolio } from '@/components/sales/commission-portfolio';
import { CommissionTermsForm } from '@/components/sales/commission-terms-form';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState, Notice } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { DEFAULT_TIME_ZONE, formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** The current service month in Europe/Prague ('YYYY-MM'). */
function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  return `${get('year')}-${get('month')}`;
}
const t = commissionsCs;
const cz = (rate: string) => rate.replace('.', ',');
const summary = (v: CommissionTermsVersion) =>
  t.terms(cz(v.initialRate), v.initialMonths, cz(v.maintenanceRate));

function History({ terms }: { terms: CommissionTerms }) {
  const c = t.history.columns;
  if (terms.history.length === 0) return <EmptyState>{t.history.empty}</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="terms-history">
        <thead className="text-xs text-stone-500">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.version}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.terms}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.reason}
            </th>
            <th scope="col" className="py-2 font-medium">
              {c.recorded}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {terms.history.map((v, i) => (
            <tr key={v.version}>
              <td className="py-2 pr-4 tabular-nums">
                {v.version}
                {i === 0 && (
                  <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                    {t.history.valid}
                  </span>
                )}
              </td>
              <td className="py-2 pr-4">{summary(v)}</td>
              <td className="py-2 pr-4 wrap-anywhere">{v.reason}</td>
              <td className="py-2 text-stone-600">
                {formatDateTimeCs(v.recordedAt)} · {v.recordedByName}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Valid({ terms }: { terms: CommissionTerms }) {
  if (!terms.valid)
    return (
      <Notice>
        <strong>{t.missing}.</strong> {t.missingHelp}
      </Notice>
    );
  return (
    <p className="text-lg font-semibold" data-testid="terms-valid">
      {summary(terms.valid)}
    </p>
  );
}

type Tab = 'settings' | 'portfolio' | 'closing' | 'statement' | 'mine';

/**
 * One main view per role (the admin's monthly overview, a salesperson's own commission) and the
 * rest as secondary links: rate settings, the portfolio, one's own commission and terms.
 */
function CommissionsNav({
  tab,
  main,
  manage,
  closing,
}: {
  tab: Tab;
  main: Tab;
  manage: boolean;
  closing: boolean;
}) {
  const href = (k: Tab) => (k === main ? '/sales/commissions' : `/sales/commissions?tab=${k}`);
  const all: Tab[] = [
    ...(closing ? (['closing'] as const) : []),
    'statement',
    ...(manage ? (['settings'] as const) : []),
    'portfolio',
    'mine',
  ];
  const secondary = all.filter((k) => k !== main);
  const testId = (k: Tab) => (k === 'closing' || k === 'statement' ? `tab-${k}` : undefined);
  return (
    <nav
      aria-label={t.title}
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="commissions-nav"
    >
      <Link
        href={href(main)}
        aria-current={tab === main ? 'page' : undefined}
        className={cn(
          'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none',
          tab === main
            ? 'bg-stone-900 text-white'
            : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
        )}
        data-testid={testId(main)}
      >
        {t.tabs[main]}
      </Link>
      <span className="text-xs text-stone-500">{t.tabs.more}</span>
      {secondary.map((k) => (
        <Link
          key={k}
          href={href(k)}
          aria-current={tab === k ? 'page' : undefined}
          className={cn(
            'text-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none',
            tab === k ? 'font-semibold text-stone-900 underline' : 'text-stone-600',
          )}
          data-testid={testId(k)}
        >
          {t.tabs[k]}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Obchod → Provize (doc 068 §2, PR 1a/1b). Portfolio: the hotels of a month (own for a
 * salesperson, everyone for `sales:manage`). Terms: a salesperson reads their own; the admin
 * (`sales:commission_terms_manage`, ADMIN only) also picks a salesperson, sees the history and
 * records a new version. The API enforces the same; this page only hides what is refused.
 */
export default async function SalesCommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; salesperson?: string; month?: string; mode?: string }>;
}) {
  const me = await requirePermission('sales:work');
  const manage = hasPermission(me, 'sales:commission_terms_manage');
  const q = await searchParams;
  const portfolioManage = hasPermission(me, 'sales:manage');
  // PR 2e: the monthly closing (finance:commissions_manage, ADMIN) and the own statement.
  const closing = hasPermission(me, 'finance:commissions_manage');
  if (q.tab === 'closing' && !closing) redirect('/forbidden');
  if (q.tab === 'settings' && !manage) redirect('/forbidden');
  // The default view: the admin's monthly overview, a salesperson's own commission. The rate
  // settings have their own explicit route (?tab=settings); an older `?salesperson=` link of the
  // settings (no tab) still opens them for the admin.
  const fallback = closing ? 'closing' : manage ? 'settings' : 'statement';
  const tab =
    q.tab === 'portfolio' ||
    q.tab === 'closing' ||
    q.tab === 'statement' ||
    q.tab === 'mine' ||
    q.tab === 'settings'
      ? q.tab
      : manage && q.salesperson
        ? 'settings'
        : fallback;
  // The last closed month by default (a month closes on the 1st of the next one, O12).
  const closedMonth = isMonth(q.month) ? q.month : previousMonth(pragueMonth());

  let body: React.ReactNode;
  if (tab === 'closing') {
    body = <CommissionClosing month={closedMonth} mode={q.mode === 'LIVE' ? 'LIVE' : 'TEST'} />;
  } else if (tab === 'statement') {
    body = <CommissionMine month={closedMonth} />;
  } else if (tab === 'portfolio') {
    const month = q.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month) ? q.month : currentMonth();
    const people = manage
      ? (await apiGet('admin/sales/commission-terms', commissionTermsOverviewSchema)).map(
          (p) => p.salesperson,
        )
      : [];
    body = (
      <CommissionPortfolio
        month={month}
        salesperson={portfolioManage ? q.salesperson : undefined}
        manage={portfolioManage}
        people={people}
      />
    );
  } else if (tab === 'mine') {
    const mine = await apiGet('admin/sales/commission-terms/mine', commissionTermsSchema);
    body = (
      <div className="flex flex-col gap-4">
        <Card title={t.mine.heading} testId="terms-mine">
          <p className="mb-3 text-sm text-stone-600">{t.mine.readOnly}</p>
          <Valid terms={mine} />
        </Card>
        <Card title={t.history.heading}>
          <History terms={mine} />
        </Card>
      </div>
    );
  } else {
    const people = await apiGet('admin/sales/commission-terms', commissionTermsOverviewSchema);
    const selectedId =
      people.find((p) => p.salesperson.id === q.salesperson)?.salesperson.id ??
      people[0]?.salesperson.id;
    const selected = selectedId
      ? await apiGet('admin/sales/commission-terms', commissionTermsSchema, {
          salesperson: selectedId,
        })
      : null;
    body =
      people.length === 0 || !selected ? (
        <EmptyState>{t.settings.none}</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <Card title={t.settings.pick}>
            <ul className="flex flex-col gap-1" data-testid="terms-people">
              {people.map((p) => (
                <li key={p.salesperson.id}>
                  <Link
                    href={`/sales/commissions?tab=settings&salesperson=${p.salesperson.id}`}
                    aria-current={p.salesperson.id === selectedId ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none',
                      p.salesperson.id === selectedId
                        ? 'bg-stone-100 font-medium'
                        : 'hover:bg-stone-50',
                    )}
                  >
                    {p.salesperson.name}
                    <span className="block text-xs text-stone-500">
                      {p.valid ? summary(p.valid) : t.missing}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <div className="flex flex-col gap-4">
            <Card title={selected.salesperson.name} testId="terms-selected">
              <Valid terms={selected} />
            </Card>
            <Card title={t.settings.newVersion}>
              <CommissionTermsForm
                key={`${selected.salesperson.id}:${selected.valid?.version ?? 0}`}
                salespersonId={selected.salesperson.id}
                expectedVersion={selected.valid?.version ?? 0}
              />
            </Card>
            <Card title={t.history.heading}>
              <History terms={selected} />
            </Card>
          </div>
        </div>
      );
  }

  return (
    <>
      <SalesHeader active="commissions" title={t.title} subtitle={t.subtitle} />
      <CommissionsNav
        tab={tab}
        main={closing ? 'closing' : manage ? 'settings' : 'statement'}
        manage={manage}
        closing={closing}
      />
      {body}
    </>
  );
}
