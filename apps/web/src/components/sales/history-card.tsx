'use client';

import {
  ACTIVITY_KINDS,
  type ActivityKind,
  type SalesActivity,
  type SalesEvent,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { Card, EmptyState } from '@/components/ui';
import { formatDateCs } from '@/i18n/cs/format';
import { salesCs } from '@/i18n/cs/sales';
import { FormDialog } from './sales-dialog';
import { salesDateTime, salesLocalOf, salesNowLocal } from './sales-format';
import { DialogError, useSalesSend } from './use-sales-send';

const h = salesCs.history;
const a = salesCs.activity;
type Contact = { id: string; label: string };

/** Time line entries: activities plus the stage and owner changes (doc 034 §5). */
type Entry =
  | { kind: 'activity'; at: string; activity: SalesActivity }
  | { kind: 'event'; at: string; event: SalesEvent };

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'ano' : 'ne';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDateCs(v);
  if (typeof v === 'string' && v in salesCs.stages)
    return salesCs.stages[v as keyof typeof salesCs.stages];
  if (typeof v === 'string' && v in salesCs.types)
    return salesCs.types[v as keyof typeof salesCs.types];
  return String(v);
};

/** One line describing an event's change (never inventing what is not stored). */
function eventText(e: SalesEvent): string {
  const p = e.payload as Record<string, unknown>;
  const changes = p.changes as Record<string, { before: unknown; after: unknown }> | undefined;
  const diff = changes
    ? Object.entries(changes)
        .filter(([k]) => !k.endsWith('Id'))
        .map(([k, c]) => `${h.fields[k] ?? k}: ${show(c.before)} → ${show(c.after)}`)
        .join('; ')
    : '';
  switch (e.type) {
    case 'STAGE_CHANGED':
      return [
        `${show(p.from)} → ${show(p.to)}`,
        p.lostReason ? `${salesCs.detail.lostReason}: ${String(p.lostReason)}` : '',
        p.reason ? `Důvod: ${String(p.reason)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'OWNER_CHANGED': {
      const from = p.from as { name: string };
      const to = p.to as { name: string };
      return [`${from.name} → ${to.name}`, p.reason ? `Důvod: ${String(p.reason)}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    case 'TASK_RESCHEDULED':
      return `${String(p.title)}: ${show(p.from)} → ${show(p.to)}${p.reason ? ` · ${String(p.reason)}` : ''}`;
    case 'TASK_CREATED':
      return `${String(p.title)} (${show(p.dueOn)})`;
    case 'TASK_DONE':
    case 'TASK_CANCELLED':
      return `${String(p.title)}${p.result ? ` · ${String(p.result)}` : ''}`;
    case 'TASK_UPDATED':
      return `${String(p.title)}${diff ? ` · ${diff}` : ''}`;
    case 'CONTACT_ADDED':
      return String(p.label);
    case 'CONTACT_RETIRED':
      return `${String(p.label)} · ${String(p.reason)}`;
    case 'CONTACT_UPDATED':
      return `${String(p.label)}${diff ? ` · ${diff}` : ''}`;
    case 'PROSPECT_CREATED':
      return String(p.name);
    default:
      return diff;
  }
}

/** Historie: the time line (activities, stage and owner changes) or every change. */
export function HistoryCard({
  code,
  activities,
  events,
  contacts,
}: {
  code: string;
  activities: SalesActivity[];
  events: SalesEvent[];
  contacts: Contact[];
}) {
  const [tab, setTab] = useState<'timeline' | 'all'>('timeline');
  const [correcting, setCorrecting] = useState<{
    activity: SalesActivity;
    withdraw: boolean;
  } | null>(null);
  const timeline: Entry[] = [
    ...activities.map((x): Entry => ({ kind: 'activity', at: x.occurredAt, activity: x })),
    ...events
      .filter((e) => e.type === 'STAGE_CHANGED' || e.type === 'OWNER_CHANGED')
      .map((e): Entry => ({ kind: 'event', at: e.occurredAt, event: e })),
  ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const tabClass = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium',
      on ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100',
    );
  return (
    <Card title={h.title} testId="history">
      <div className="mb-4 flex gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'timeline'}
          className={tabClass(tab === 'timeline')}
          onClick={() => setTab('timeline')}
          data-testid="history-timeline"
        >
          {h.activities}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={tabClass(tab === 'all')}
          onClick={() => setTab('all')}
          data-testid="history-all"
        >
          {h.allChanges}
        </button>
      </div>
      {tab === 'timeline' ? (
        timeline.length === 0 ? (
          <EmptyState>{h.empty}</EmptyState>
        ) : (
          <ol className="flex flex-col gap-4" data-testid="timeline">
            {timeline.map((entry) =>
              entry.kind === 'activity' ? (
                <ActivityItem
                  key={entry.activity.id}
                  activity={entry.activity}
                  onCorrect={(withdraw) => setCorrecting({ activity: entry.activity, withdraw })}
                />
              ) : (
                <li
                  key={entry.event.id}
                  className="border-l-2 border-stone-200 pl-3 text-sm text-stone-600"
                  data-testid="timeline-event"
                >
                  <p className="text-xs text-stone-500">
                    {salesDateTime(entry.event.occurredAt)} · {entry.event.actor}
                  </p>
                  <p>
                    <span className="font-medium text-stone-800">{h.events[entry.event.type]}</span>
                    : {eventText(entry.event)}
                  </p>
                </li>
              ),
            )}
          </ol>
        )
      ) : (
        <ol className="flex flex-col gap-2 text-sm" data-testid="all-changes">
          {events.map((e) => (
            <li key={e.id} className="border-b border-stone-100 pb-2 last:border-0">
              <p className="text-xs text-stone-500">
                {salesDateTime(e.occurredAt)} · {e.actor}
              </p>
              <p className="wrap-anywhere">
                <span className="font-medium">{h.events[e.type]}</span>
                {eventText(e) ? `: ${eventText(e)}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      {correcting && (
        <CorrectDialog
          key={correcting.activity.id}
          code={code}
          contacts={contacts}
          {...correcting}
          onClose={() => setCorrecting(null)}
        />
      )}
    </Card>
  );
}

function ActivityItem({
  activity: x,
  onCorrect,
}: {
  activity: SalesActivity;
  onCorrect: (withdraw: boolean) => void;
}) {
  const original = x.withdrawn ? x.earlier.at(-1) : null;
  return (
    <li
      className={cn(
        'border-l-2 pl-3',
        x.withdrawn ? 'border-stone-200 text-stone-400' : 'border-stone-800',
      )}
      data-testid="timeline-activity"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-stone-500">
          <span
            className={cn(
              'mr-2 font-semibold uppercase tracking-wide',
              x.withdrawn ? 'line-through' : 'text-stone-800',
            )}
          >
            {salesCs.kinds[x.kind]}
          </span>
          {salesDateTime(x.occurredAt)}
          {x.contact && ` · ${x.contact.label}`}
        </p>
        {!x.withdrawn && (
          <div className="flex gap-3 text-xs">
            <button
              type="button"
              className="text-stone-500 hover:underline"
              onClick={() => onCorrect(false)}
              data-testid="activity-correct"
            >
              {a.correct}
            </button>
            <button
              type="button"
              className="text-stone-500 hover:underline"
              onClick={() => onCorrect(true)}
              data-testid="activity-withdraw"
            >
              {a.withdraw}
            </button>
          </div>
        )}
      </div>
      <p
        className={cn(
          'mt-1 text-sm whitespace-pre-line wrap-anywhere',
          x.withdrawn && 'line-through',
        )}
      >
        {x.content ?? original?.content}
      </p>
      {(x.outcome ?? original?.outcome) && (
        <p className="mt-1 text-sm font-medium wrap-anywhere">→ {x.outcome ?? original?.outcome}</p>
      )}
      <p className="mt-1 text-xs text-stone-500">
        {a.recorded(
          x.withdrawn ? (original?.author ?? x.author) : x.author,
          salesDateTime(x.withdrawn ? (original?.recordedAt ?? x.recordedAt) : x.recordedAt),
        )}
        {x.correctionReason &&
          ` · ${x.withdrawn ? a.withdrawn(x.correctionReason) : a.corrected(x.correctionReason)} (${x.author})`}
      </p>
      {x.earlier.length > 0 && !x.withdrawn && (
        <details className="mt-1 text-xs text-stone-500">
          <summary className="cursor-pointer">{a.earlier(x.earlier.length)}</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {x.earlier.map((v) => (
              <li key={v.id} className="wrap-anywhere">
                {salesCs.kinds[v.kind]} · {salesDateTime(v.occurredAt)} · {v.content} ({v.author})
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function CorrectDialog({
  code,
  contacts,
  activity,
  withdraw,
  onClose,
}: {
  code: string;
  contacts: Contact[];
  activity: SalesActivity;
  withdraw: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const [v, setV] = useState({
    kind: activity.kind,
    occurredAt: salesLocalOf(activity.occurredAt),
    contactId: activity.contact?.id ?? '',
    content: activity.content ?? '',
    outcome: activity.outcome ?? '',
    reason: '',
  });
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, send } = useSalesSend();
  // The current contact of the activity stays selectable even if it was retired since.
  const options =
    activity.contact && !contacts.some((c) => c.id === activity.contact!.id)
      ? [...contacts, activity.contact]
      : contacts;
  return (
    <FormDialog
      open
      wide={!withdraw}
      title={withdraw ? a.withdrawTitle : a.correctTitle}
      submitLabel={withdraw ? a.withdraw : a.correct}
      busy={busy}
      testId="correct-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={onClose}
      onSubmit={() => {
        setInvalid(null);
        if (v.reason.trim().length < 3) return setInvalid(salesCs.invalid);
        const path = `admin/sales/prospects/${code}/activities/${activity.id}/correct`;
        if (withdraw) return void send(path, { withdraw: true, reason: v.reason.trim() }, onClose);
        if (!v.content.trim() || !v.occurredAt) return setInvalid(salesCs.invalid);
        if (v.occurredAt > salesNowLocal()) return setInvalid(a.inFuture);
        void send(
          path,
          {
            withdraw: false,
            kind: v.kind,
            occurredAt: v.occurredAt,
            contactId: v.contactId || null,
            content: v.content.trim(),
            outcome: v.outcome.trim() || null,
            reason: v.reason.trim(),
          },
          onClose,
        );
      }}
    >
      {withdraw ? (
        <p className="text-stone-600">{a.withdrawText}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id={`${id}-kind`} label={a.kind}>
              <select
                id={`${id}-kind`}
                value={v.kind}
                onChange={(e) => setV({ ...v, kind: e.target.value as ActivityKind })}
                className={fieldClass(false)}
              >
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {salesCs.kinds[k]}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id={`${id}-at`} label={a.occurredAt}>
              <input
                id={`${id}-at`}
                type="datetime-local"
                max={salesNowLocal()}
                value={v.occurredAt}
                onChange={(e) => setV({ ...v, occurredAt: e.target.value })}
                className={fieldClass(false)}
              />
            </FormField>
          </div>
          <FormField id={`${id}-contact`} label={a.contact}>
            <select
              id={`${id}-contact`}
              value={v.contactId}
              onChange={(e) => setV({ ...v, contactId: e.target.value })}
              className={fieldClass(false)}
            >
              <option value="">{a.noContact}</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id={`${id}-content`} label={a.content}>
            <textarea
              id={`${id}-content`}
              rows={4}
              maxLength={4000}
              value={v.content}
              onChange={(e) => setV({ ...v, content: e.target.value })}
              className={fieldClass(false)}
            />
          </FormField>
          <FormField id={`${id}-outcome`} label={a.outcome}>
            <input
              id={`${id}-outcome`}
              maxLength={1000}
              value={v.outcome}
              onChange={(e) => setV({ ...v, outcome: e.target.value })}
              className={fieldClass(false)}
            />
          </FormField>
        </>
      )}
      <FormField id={`${id}-reason`} label={a.reason}>
        <input
          id={`${id}-reason`}
          maxLength={500}
          value={v.reason}
          onChange={(e) => setV({ ...v, reason: e.target.value })}
          className={fieldClass(false)}
          data-testid="correct-reason"
        />
      </FormField>
    </FormDialog>
  );
}
