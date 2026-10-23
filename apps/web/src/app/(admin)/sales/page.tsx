import { salesOverviewSchema, type SalesTask } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { dueClass, dueLabel, stageClass } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { TaskList } from '@/components/sales/task-list';
import { buttonClass, Card, CardLink, EmptyState, Notice, Stat } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const o = salesCs.overview;

/**
 * Přehled obchodu (doc 034 §9): what to do today, what is overdue, the next 7 days and the
 * prospects in progress — the salesperson's own work (ADMIN can switch to everyone).
 */
export default async function SalesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const me = await currentUser();
  const canManage = hasPermission(me, 'sales:manage');
  const v = await apiGet('admin/sales/overview', salesOverviewSchema, {
    scope: canManage && scope === 'all' ? 'all' : undefined,
  });
  const all = v.scope === 'all';
  const tasksHref = all ? '/sales/tasks?assignee=all' : '/sales/tasks';
  const section = (
    title: string,
    tasks: SalesTask[],
    count: number,
    empty: string,
    testId: string,
    tone?: 'warning',
  ) => (
    <Card
      title={`${title} (${count})`}
      testId={testId}
      className={tone === 'warning' && count > 0 ? 'border-red-200' : undefined}
      action={
        count > tasks.length ? (
          <CardLink href={tasksHref}>{o.more(count - tasks.length)}</CardLink>
        ) : undefined
      }
    >
      {tasks.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <TaskList tasks={tasks} today={v.today} showProspect showAssignee={all} />
      )}
    </Card>
  );
  return (
    <>
      <SalesHeader
        active="overview"
        title={o.title}
        subtitle={o.subtitle}
        actions={
          <>
            <Link
              href="/sales/prospects/new"
              className={buttonClass.primary}
              data-testid="overview-new-prospect"
            >
              {o.newProspect}
            </Link>
            {canManage && (
              <Link
                href={all ? '/sales' : '/sales?scope=all'}
                className={buttonClass.secondary}
                data-testid="overview-scope"
              >
                {all ? o.mine : o.all}
              </Link>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Stat
            label={o.overdue}
            value={v.counts.overdue}
            tone={v.counts.overdue > 0 ? 'error' : 'neutral'}
            testId="count-overdue"
          />
          <Stat
            label={o.today}
            value={v.counts.dueToday}
            tone={v.counts.dueToday > 0 ? 'warning' : 'neutral'}
            testId="count-today"
          />
          <Stat label={o.upcoming} value={v.counts.upcoming} testId="count-upcoming" />
          <Stat
            label={o.inProgress}
            value={v.counts.inProgress}
            href="/sales/prospects"
            testId="count-in-progress"
          />
        </div>
        {v.counts.withoutNextStep > 0 && (
          <Notice tone="warning">{o.withoutNextStep(v.counts.withoutNextStep)}</Notice>
        )}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-6">
            {section(
              o.overdue,
              v.overdue,
              v.counts.overdue,
              o.noOverdue,
              'overview-overdue',
              'warning',
            )}
            {section(o.today, v.dueToday, v.counts.dueToday, o.noToday, 'overview-today')}
            {section(o.upcoming, v.upcoming, v.counts.upcoming, o.noUpcoming, 'overview-upcoming')}
          </div>
          <Card
            title={`${o.inProgress} (${v.counts.inProgress})`}
            testId="overview-in-progress"
            action={<CardLink href="/sales/prospects">{o.allProspects}</CardLink>}
          >
            {v.inProgress.length === 0 ? (
              <EmptyState>{o.noInProgress}</EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-stone-100">
                {v.inProgress.map((p) => {
                  const due = p.nextTask ? dueLabel(p.nextTask.dueOn, v.today) : null;
                  return (
                    <li
                      key={p.code}
                      className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
                      data-testid={`in-progress-${p.code}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          href={`/sales/prospects/${p.code}`}
                          className="min-w-0 font-medium underline-offset-2 hover:underline wrap-anywhere"
                        >
                          {p.name}
                        </Link>
                        <span
                          className={cn(
                            'rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                            stageClass[p.stage],
                          )}
                        >
                          {salesCs.stages[p.stage]}
                        </span>
                      </div>
                      <p className="text-sm wrap-anywhere">
                        {p.nextTask && due ? (
                          <>
                            <span className={cn('mr-2', dueClass[due.tone])}>{due.text}</span>
                            {p.nextTask.title}
                          </>
                        ) : (
                          <span className="text-amber-800">{salesCs.list.noNext}</span>
                        )}
                      </p>
                      {all && <p className="text-xs text-stone-500">{p.owner.name}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <p className="text-xs text-stone-500">{salesCs.timeZoneNote}</p>
      </div>
    </>
  );
}
