import { prospectCodeSchema, prospectDetailSchema, salespersonSchema } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ContactsCard } from '@/components/sales/contacts-card';
import { HistoryCard } from '@/components/sales/history-card';
import { ProspectActions, RestoreButton } from '@/components/sales/prospect-actions';
import { dueClass, dueLabel, salesDateTime, stageClass } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { TaskList } from '@/components/sales/task-list';
import { SuccessNote } from '@/components/catalog/form-kit';
import { Card, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { salesCs as t } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Detail zájemce (doc 034 §9): identification, stage, priority, owner and the next step on top;
 * the quick actions; tasks, contacts and the history. Another salesperson's prospect is a 404.
 */
export default async function ProspectPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ created?: string; saved?: string }>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  if (!prospectCodeSchema.safeParse(code).success) notFound();
  const [me, p] = await Promise.all([
    currentUser(),
    apiGet(`admin/sales/prospects/${code}`, prospectDetailSchema),
  ]);
  const canManage = hasPermission(me, 'sales:manage');
  const salespeople = canManage
    ? await apiGet('admin/sales/salespeople', z.array(salespersonSchema))
    : null;
  const contacts = p.contacts.filter((c) => !c.retired).map((c) => ({ id: c.id, label: c.label }));
  // Who a task may be given to: the owner, or a sales administrator (doc 034 §7).
  const assignees = salespeople
    ? salespeople
        .filter((s) => s.manages || s.id === p.owner.id)
        .map((s) => ({ id: s.id, label: s.name }))
    : null;
  const archived = p.archived;
  const next = p.openTasks[0] ?? null;
  const due = next ? dueLabel(next.dueOn, p.today) : null;
  const d = t.detail;
  const address = [
    p.addressLine1,
    p.addressLine2,
    [p.postalCode, p.city].filter(Boolean).join(' '),
    p.countryCode,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <>
      <SalesHeader
        active="prospects"
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono">{p.code}</span>
            <span>{[p.city, p.countryCode].filter(Boolean).join(', ')}</span>
          </span>
        }
        back={{ href: '/sales/prospects', label: t.list.title }}
      />
      <div className="flex flex-col gap-6">
        {sp.created && <SuccessNote>{t.detail.createdNote}</SuccessNote>}
        {sp.saved && <SuccessNote>{t.detail.saved}</SuccessNote>}

        <Card testId="prospect-summary">
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-stone-500">{d.stage}</dt>
                <dd>
                  <span
                    className={cn(
                      'inline-block rounded px-2 py-0.5 text-sm font-medium',
                      stageClass[p.stage],
                    )}
                    data-testid="prospect-stage"
                  >
                    {t.stages[p.stage]}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-stone-500">{d.priority}</dt>
                <dd className="font-medium" data-testid="prospect-priority">
                  {p.priority ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-stone-500">{d.owner}</dt>
                <dd className="font-medium wrap-anywhere" data-testid="prospect-owner">
                  {p.owner.name}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-stone-500">{d.lastContact}</dt>
                <dd data-testid="prospect-last-contact">
                  {p.lastContactAt ? salesDateTime(p.lastContactAt) : d.noContactYet}
                </dd>
              </div>
            </dl>
            {archived && (
              <div
                className="flex flex-col gap-3 rounded-md border border-stone-300 bg-stone-100 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                data-testid="prospect-archived"
              >
                <p className="wrap-anywhere">
                  <span className="font-semibold">{d.archivedTitle}.</span>{' '}
                  {d.archivedText(archived.by, salesDateTime(archived.at), archived.reason)}
                </p>
                <div className="shrink-0">
                  <RestoreButton prospect={p} />
                </div>
              </div>
            )}
            {p.stage === 'LOST' && p.lostReason && (
              <Notice tone="info">
                {d.lostReason}: {p.lostReason}
              </Notice>
            )}
            {/* An archived prospect takes no new work: no "add a task" prompt. */}
            {!archived && (
              <div
                className="rounded-md border border-stone-200 bg-stone-50 px-4 py-3"
                data-testid="prospect-next"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                  {d.nextTask}
                </p>
                {next && due ? (
                  <p className="mt-1 text-sm wrap-anywhere">
                    <span className={cn('mr-2', dueClass[due.tone])}>{due.text}</span>
                    <span className="font-medium">{next.title}</span>
                    {next.contact && (
                      <span className="text-stone-500"> · {next.contact.label}</span>
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-amber-800">{d.noNextTask}</p>
                )}
              </div>
            )}
            {!archived && (
              <ProspectActions
                prospect={{ code: p.code, stage: p.stage, revision: p.revision, owner: p.owner }}
                contacts={contacts}
                salespeople={salespeople}
                openTasks={p.openTasks}
                today={p.today}
              />
            )}
          </div>
        </Card>

        {p.duplicates.accessible.length > 0 && (
          <Notice tone="warning">
            <span data-testid="detail-duplicates">
              {d.duplicates}:{' '}
              {p.duplicates.accessible.map((x, i) => (
                <span key={x.code}>
                  {i > 0 && ', '}
                  <Link href={`/sales/prospects/${x.code}`} className="underline">
                    {x.name}
                  </Link>
                  {x.archived && ` (${t.list.archivedBadge})`}
                </span>
              ))}
            </span>
          </Notice>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card title={t.task.open} testId="open-tasks" id="open-tasks">
              {p.openTasks.length === 0 ? (
                <EmptyState>{archived ? t.task.noneArchived : t.task.none}</EmptyState>
              ) : (
                <TaskList
                  tasks={p.openTasks}
                  today={p.today}
                  showAssignee={canManage}
                  contacts={contacts}
                  assignees={assignees}
                  testId="open-task-list"
                />
              )}
              {p.closedTasks.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm text-stone-500">
                    {t.task.closed} ({p.closedTasks.length})
                  </summary>
                  <div className="mt-3">
                    <TaskList tasks={p.closedTasks} today={p.today} />
                  </div>
                </details>
              )}
            </Card>
            <HistoryCard
              code={p.code}
              activities={p.activities}
              events={p.events}
              contacts={contacts}
              readOnly={!!archived}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <ContactsCard code={p.code} contacts={p.contacts} readOnly={!!archived} />
            <Card
              title={d.profile}
              testId="prospect-profile"
              action={
                archived ? undefined : (
                  <Link
                    href={`/sales/prospects/${p.code}/edit`}
                    className="font-medium text-stone-700 hover:underline"
                    data-testid="edit-prospect"
                  >
                    {d.edit}
                  </Link>
                )
              }
            >
              <FieldList>
                <Field label={d.rooms}>{p.roomsEstimate ?? t.roomsUnknown}</Field>
                <Field label={d.type}>
                  {p.accommodationType ? t.types[p.accommodationType] : t.unknown}
                </Field>
                <Field label={d.address}>{address || t.unknown}</Field>
                <Field label={d.website}>
                  {p.website ? (
                    <a
                      href={/^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline"
                    >
                      {p.website}
                    </a>
                  ) : (
                    t.unknown
                  )}
                </Field>
                <Field label={d.source}>{p.source ?? t.unknown}</Field>
                <Field label={d.firstContact}>
                  {p.firstContactAt ? salesDateTime(p.firstContactAt) : d.noContactYet}
                </Field>
                <Field label={d.note}>
                  <span className="whitespace-pre-line">{p.note ?? '—'}</span>
                </Field>
              </FieldList>
              <p className="mt-4 text-xs text-stone-500">
                {d.created(p.createdBy, salesDateTime(p.createdAt))}
              </p>
            </Card>
          </div>
        </div>
        <p className="text-xs text-stone-500">{t.timeZoneNote}</p>
      </div>
    </>
  );
}
