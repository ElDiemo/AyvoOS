import {
  ACTIVITY_KINDS,
  PROSPECT_STAGES,
  salesResultsQuerySchema,
  salesResultsSchema,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { stageClass } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState, Stat } from '@/components/ui';
import { formatDateCs } from '@/i18n/cs/format';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.results;

/**
 * Výsledky obchodu (the owner, sales:manage): the funnel now and what moved in the last 7, 30 or
 * 90 days, for everyone — read only from what Obchod records.
 */
export default async function SalesResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requirePermission('sales:manage');
  const parsed = salesResultsQuerySchema.safeParse({ days: (await searchParams).days });
  const q = parsed.success ? parsed.data : salesResultsQuerySchema.parse({});
  const r = await apiGet('admin/sales/results', salesResultsSchema, { days: q.days });
  const pill = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium',
      on
        ? 'bg-stone-900 text-white'
        : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    );
  const stages = (counts: Record<string, number>, testId: string) => (
    <ul className="flex flex-col divide-y divide-stone-100" data-testid={testId}>
      {PROSPECT_STAGES.map((s) => (
        <li key={s} className="flex items-center justify-between py-2 text-sm">
          <span className={cn('rounded px-2 py-0.5 text-xs font-medium', stageClass[s])}>
            {salesCs.stages[s]}
          </span>
          <span className="font-semibold tabular-nums" data-testid={`${testId}-${s}`}>
            {counts[s]}
          </span>
        </li>
      ))}
    </ul>
  );
  const c = t.columns;
  return (
    <>
      <SalesHeader
        active="results"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <div className="flex gap-2" data-testid="results-period">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`/sales/results?days=${d}`} className={pill(q.days === d)}>
                {t.period(d)}
              </Link>
            ))}
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        <p className="text-sm text-stone-600">
          {t.since(formatDateCs(r.since), formatDateCs(r.today))}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label={t.created} value={r.created} testId="results-created" />
          <Stat label={t.calls} value={r.activities.CALL} testId="results-calls" />
          <Stat label={t.meetings} value={r.activities.MEETING} testId="results-meetings" />
          <Stat label={t.offers} value={r.activities.OFFER} testId="results-offers" />
          <Stat label={t.won} value={r.reached.WON} testId="results-won" />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card title={t.funnel} testId="results-funnel">
            <p className="mb-2 text-xs text-stone-500">{t.funnelHelp}</p>
            {stages(r.funnel, 'funnel')}
          </Card>
          <Card title={t.reached} testId="results-reached">
            <p className="mb-2 text-xs text-stone-500">{t.reachedHelp}</p>
            {stages(r.reached, 'reached')}
          </Card>
          <Card title={t.activities} testId="results-activities">
            <p className="mb-2 text-xs text-stone-500">{t.activitiesHelp}</p>
            <ul className="flex flex-col divide-y divide-stone-100">
              {ACTIVITY_KINDS.map((k) => (
                <li key={k} className="flex items-center justify-between py-2 text-sm">
                  <span>{salesCs.kinds[k]}</span>
                  <span className="font-semibold tabular-nums" data-testid={`activities-${k}`}>
                    {r.activities[k]}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <Card title={t.attention} testId="results-attention">
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span>{t.withoutNextStep}</span>
              <span className="flex items-center gap-3">
                <span
                  className={cn(
                    'font-semibold tabular-nums',
                    r.withoutNextStep > 0 && 'text-amber-800',
                  )}
                  data-testid="results-without-next-step"
                >
                  {r.withoutNextStep}
                </span>
                <Link
                  href="/sales/prospects?next=none&phase=in-progress"
                  className="underline"
                  data-testid="results-without-next-step-link"
                >
                  {t.showList}
                </Link>
              </span>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span>{t.overdue}</span>
              <span className="flex items-center gap-3">
                <span
                  className={cn('font-semibold tabular-nums', r.overdueTasks > 0 && 'text-red-700')}
                  data-testid="results-overdue"
                >
                  {r.overdueTasks}
                </span>
                <Link href="/sales/tasks?assignee=all" className="underline">
                  {t.showList}
                </Link>
              </span>
            </li>
          </ul>
        </Card>
        <Card title={t.people} testId="results-people">
          {r.people.length === 0 ? (
            <EmptyState>{t.noPeople}</EmptyState>
          ) : (
            <>
              {/* Wide screens: a table. */}
              <table className="hidden w-full text-sm md:table">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs text-stone-500">
                    <th className="py-2 font-medium">{c.name}</th>
                    {(
                      [
                        'inProgress',
                        'withoutNextStep',
                        'calls',
                        'meetings',
                        'offers',
                        'won',
                      ] as const
                    ).map((k) => (
                      <th key={k} className="py-2 text-right font-medium">
                        {c[k]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.people.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-stone-100 last:border-0"
                      data-testid={`results-person-${p.id}`}
                    >
                      <td className="py-2">
                        <Link
                          href={`/sales/prospects?owner=${p.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {p.name}
                        </Link>
                      </td>
                      <td className="py-2 text-right tabular-nums">{p.inProgress}</td>
                      <td
                        className={cn(
                          'py-2 text-right tabular-nums',
                          p.withoutNextStep > 0 && 'font-semibold text-amber-800',
                        )}
                      >
                        {p.withoutNextStep}
                      </td>
                      <td className="py-2 text-right tabular-nums">{p.calls}</td>
                      <td className="py-2 text-right tabular-nums">{p.meetings}</td>
                      <td className="py-2 text-right tabular-nums">{p.offers}</td>
                      <td className="py-2 text-right tabular-nums">{p.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Phones: one card per person. */}
              <ul className="flex flex-col divide-y divide-stone-100 md:hidden">
                {r.people.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <Link href={`/sales/prospects?owner=${p.id}`} className="font-medium underline">
                      {p.name}
                    </Link>
                    <p className="text-xs text-stone-600">
                      {c.inProgress} {p.inProgress} · {c.withoutNextStep} {p.withoutNextStep} ·{' '}
                      {c.calls} {p.calls} · {c.meetings} {p.meetings} · {c.offers} {p.offers} ·{' '}
                      {c.won} {p.won}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <p className="text-xs text-stone-500">{salesCs.timeZoneNote}</p>
      </div>
    </>
  );
}
