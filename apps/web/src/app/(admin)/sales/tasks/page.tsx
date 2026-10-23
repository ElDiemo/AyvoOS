import { salespersonSchema, taskListQuerySchema, taskPageSchema } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import { SalesHeader } from '@/components/sales/sales-header';
import { TaskList } from '@/components/sales/task-list';
import { Card, EmptyState } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.tasks;

/** Úkoly (doc 034 §9): open tasks by due date (overdue first), or the closed ones. */
export default async function SalesTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ assignee?: string; status?: string; page?: string }>;
}) {
  const raw = await searchParams;
  const me = await currentUser();
  const canManage = hasPermission(me, 'sales:manage');
  const parsed = taskListQuerySchema.safeParse({
    assignee: canManage ? (raw.assignee ?? 'me') : 'me',
    status: raw.status,
    page: raw.page,
  });
  const q = parsed.success ? parsed.data : taskListQuerySchema.parse({});
  const [page, people] = await Promise.all([
    apiGet('admin/sales/tasks', taskPageSchema, {
      assignee: q.assignee,
      status: q.status,
      page: q.page,
    }),
    canManage ? apiGet('admin/sales/salespeople', z.array(salespersonSchema)) : null,
  ]);
  const href = (patch: Record<string, string>) =>
    `/sales/tasks?${new URLSearchParams({ assignee: q.assignee, status: q.status, ...patch }).toString()}`;
  const pill = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium',
      on
        ? 'bg-stone-900 text-white'
        : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    );
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <>
      <SalesHeader active="tasks" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2" data-testid="task-filters">
          <Link href={href({ status: 'OPEN', page: '1' })} className={pill(q.status === 'OPEN')}>
            {t.open}
          </Link>
          <Link
            href={href({ status: 'CLOSED', page: '1' })}
            className={pill(q.status === 'CLOSED')}
          >
            {t.closed}
          </Link>
          {canManage && (
            <>
              <span className="mx-1 w-px self-stretch bg-stone-200" />
              <Link
                href={href({ assignee: 'me', page: '1' })}
                className={pill(q.assignee === 'me')}
              >
                {t.mine}
              </Link>
              <Link
                href={href({ assignee: 'all', page: '1' })}
                className={pill(q.assignee === 'all')}
              >
                {t.all}
              </Link>
              {(people ?? [])
                .filter((p) => p.id !== me.user.id)
                .map((p) => (
                  <Link
                    key={p.id}
                    href={href({ assignee: p.id, page: '1' })}
                    className={pill(q.assignee === p.id)}
                  >
                    {p.name}
                  </Link>
                ))}
            </>
          )}
        </div>
        <Card
          title={`${q.status === 'OPEN' ? t.open : t.closed} (${page.total})`}
          testId="task-page"
        >
          {page.items.length === 0 ? (
            <EmptyState>{q.status === 'OPEN' ? t.empty : t.emptyClosed}</EmptyState>
          ) : (
            <TaskList
              tasks={page.items}
              today={page.today}
              showProspect
              showAssignee={q.assignee !== 'me'}
            />
          )}
          {pages > 1 && (
            <nav className="mt-4 flex justify-between border-t border-stone-100 pt-4 text-sm">
              {q.page > 1 ? (
                <Link href={href({ page: String(q.page - 1) })}>{salesCs.list.previous}</Link>
              ) : (
                <span />
              )}
              <span>{salesCs.list.page(q.page, pages)}</span>
              {q.page < pages ? (
                <Link href={href({ page: String(q.page + 1) })}>{salesCs.list.nextPage}</Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </Card>
        <p className="text-xs text-stone-500">{salesCs.timeZoneNote}</p>
      </div>
    </>
  );
}
