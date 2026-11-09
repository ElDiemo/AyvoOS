import {
  salesCalendarQuerySchema,
  salesCalendarSchema,
  salespersonSchema,
  type SalesTask,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState, Notice } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.calendar;
/** Tasks shown in one day's cell of the grid; the rest are counted. */
const PER_CELL = 4;

const pad = (n: number) => String(n).padStart(2, '0');
const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/** A task in the calendar: its title, its prospect, and whether it is done or overdue. */
function TaskChip({
  task,
  today,
  showAssignee,
}: {
  task: SalesTask;
  today: string;
  showAssignee: boolean;
}) {
  const overdue = task.status === 'OPEN' && task.dueOn < today;
  return (
    <Link
      href={`/sales/prospects/${task.prospect.code}`}
      title={`${task.title} — ${task.prospect.name}`}
      data-testid={`calendar-task-${task.id}`}
      className={cn(
        'block rounded-md border px-2 py-1 text-xs leading-snug hover:bg-stone-50',
        task.status === 'OPEN'
          ? overdue
            ? 'border-red-300 bg-red-50 text-red-900'
            : 'border-stone-300 bg-white text-stone-900'
          : 'border-stone-200 bg-stone-50 text-stone-500 line-through',
      )}
    >
      <span className="block truncate font-medium">{task.title}</span>
      <span className="block truncate text-[11px] text-stone-500 no-underline">
        {task.prospect.name}
        {showAssignee && ` · ${task.assignee.name}`}
        {task.status === 'DONE' && ` · ${t.done}`}
        {task.status === 'CANCELLED' && ` · ${t.cancelled}`}
        {overdue && ` · ${t.overdueTag}`}
      </span>
    </Link>
  );
}

/**
 * Kalendář (sales): the tasks of one month by day — a month grid on wide screens, the days with
 * tasks as a list on narrow ones. The same people as "Úkoly" (mine; with sales:manage everyone
 * or one salesperson). Each task leads to its prospect, where it is done or rescheduled.
 */
export default async function SalesCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; assignee?: string }>;
}) {
  const raw = await searchParams;
  const me = await currentUser();
  const canManage = hasPermission(me, 'sales:manage');
  const parsed = salesCalendarQuerySchema.safeParse({
    month: raw.month,
    assignee: canManage ? (raw.assignee ?? 'me') : 'me',
  });
  const q = parsed.success ? parsed.data : salesCalendarQuerySchema.parse({});
  const [cal, people] = await Promise.all([
    apiGet('admin/sales/tasks/calendar', salesCalendarSchema, {
      ...(q.month ? { month: q.month } : {}),
      assignee: q.assignee,
    }),
    canManage ? apiGet('admin/sales/salespeople', z.array(salespersonSchema)) : null,
  ]);
  const month = cal.month;
  const href = (patch: Record<string, string>) =>
    `/sales/calendar?${new URLSearchParams({ month, assignee: q.assignee, ...patch }).toString()}`;
  const pill = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium',
      on
        ? 'bg-stone-900 text-white'
        : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    );

  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Monday first: 0 = Monday … 6 = Sunday.
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDay = new Map<string, SalesTask[]>();
  for (const task of cal.items) {
    const list = byDay.get(task.dueOn) ?? [];
    list.push(task);
    byDay.set(task.dueOn, list);
  }
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => `${month}-${pad(i + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const showAssignee = q.assignee !== 'me';
  const weekday = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;
  const title = `${t.months[m - 1]} ${y}`;

  return (
    <>
      <SalesHeader active="calendar" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2" data-testid="calendar-nav">
            <Link
              href={href({ month: shift(month, -1) })}
              className={pill(false)}
              aria-label={t.previous}
            >
              <span aria-hidden="true">←</span>
            </Link>
            <h2
              className="min-w-36 text-center text-lg font-semibold capitalize"
              aria-live="polite"
            >
              {title}
            </h2>
            <Link
              href={href({ month: shift(month, 1) })}
              className={pill(false)}
              aria-label={t.next}
            >
              <span aria-hidden="true">→</span>
            </Link>
            <Link href={href({ month: cal.today.slice(0, 7) })} className={pill(false)}>
              {t.today}
            </Link>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2" data-testid="calendar-people">
              <Link href={href({ assignee: 'me' })} className={pill(q.assignee === 'me')}>
                {salesCs.tasks.mine}
              </Link>
              <Link href={href({ assignee: 'all' })} className={pill(q.assignee === 'all')}>
                {salesCs.tasks.all}
              </Link>
              {(people ?? [])
                .filter((p) => p.id !== me.user.id)
                .map((p) => (
                  <Link
                    key={p.id}
                    href={href({ assignee: p.id })}
                    className={pill(q.assignee === p.id)}
                  >
                    {p.name}
                  </Link>
                ))}
            </div>
          )}
        </div>

        {cal.overdueBefore > 0 && (
          <Notice tone="warning">
            {t.overdue(cal.overdueBefore)}{' '}
            <Link
              href={`/sales/tasks?${new URLSearchParams({ assignee: q.assignee, status: 'OPEN' })}`}
              className="font-medium underline"
            >
              {t.showOverdue}
            </Link>
          </Notice>
        )}
        {cal.truncated && <Notice tone="warning">{t.truncated}</Notice>}

        {/* Wide screens: the month grid. */}
        <Card className="hidden md:block" testId="calendar-grid">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-stone-200 bg-stone-200">
            {t.weekdays.map((d) => (
              <div
                key={d}
                className="bg-stone-50 px-2 py-1.5 text-center text-xs font-medium text-stone-500 uppercase"
              >
                {d}
              </div>
            ))}
            {cells.map((day, i) => {
              if (!day) return <div key={`blank-${i}`} className="min-h-28 bg-stone-50/60" />;
              const tasks = byDay.get(day) ?? [];
              const isToday = day === cal.today;
              return (
                <div
                  key={day}
                  className={cn(
                    'flex min-h-28 flex-col gap-1 bg-white p-1.5',
                    isToday && 'bg-emerald-50/60',
                  )}
                  data-testid={`calendar-day-${day}`}
                >
                  <span
                    className={cn(
                      'self-end rounded-full px-1.5 text-xs font-medium',
                      isToday ? 'bg-emerald-800 text-white' : 'text-stone-500',
                    )}
                    aria-current={isToday ? 'date' : undefined}
                  >
                    {Number(day.slice(8))}
                  </span>
                  {tasks.slice(0, PER_CELL).map((task) => (
                    <TaskChip
                      key={task.id}
                      task={task}
                      today={cal.today}
                      showAssignee={showAssignee}
                    />
                  ))}
                  {tasks.length > PER_CELL && (
                    <span className="px-1 text-xs text-stone-500">
                      {t.more(tasks.length - PER_CELL)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Narrow screens: the days that have tasks, as a list. */}
        <Card className="md:hidden" testId="calendar-agenda">
          {cal.items.length === 0 ? (
            <EmptyState>{t.empty}</EmptyState>
          ) : (
            <ol className="flex flex-col">
              {[...byDay.keys()].sort().map((day) => (
                <li
                  key={day}
                  className="flex flex-col gap-1.5 border-t border-stone-100 py-3 first:border-t-0 first:pt-0"
                  data-testid={`agenda-day-${day}`}
                >
                  <h3
                    className={cn(
                      'text-sm font-semibold',
                      day === cal.today ? 'text-emerald-800' : 'text-stone-800',
                    )}
                  >
                    {t.weekdaysLong[weekday(day)]} {Number(day.slice(8))}. {m}.
                    {day === cal.today && ` · ${t.today}`}
                  </h3>
                  {byDay.get(day)!.map((task) => (
                    <TaskChip
                      key={task.id}
                      task={task}
                      today={cal.today}
                      showAssignee={showAssignee}
                    />
                  ))}
                </li>
              ))}
            </ol>
          )}
        </Card>
        {cal.items.length === 0 && (
          <p className="hidden text-sm text-stone-500 md:block">{t.empty}</p>
        )}
        <p className="text-xs text-stone-500">{salesCs.timeZoneNote}</p>
      </div>
    </>
  );
}
