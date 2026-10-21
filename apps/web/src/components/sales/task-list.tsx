'use client';

import type { SalesTask } from '@ayvo/types';
import Link from 'next/link';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { salesCs } from '@/i18n/cs/sales';
import { FormDialog } from './sales-dialog';
import { dueClass, dueLabel, salesDateTime } from './sales-format';
import { DialogError, useSalesSend } from './use-sales-send';

const tk = salesCs.task;

/**
 * Tasks with their actions: done (an optional result — never a stage change), reschedule and
 * cancel (with a reason). `showProspect` for lists across prospects (overview, Úkoly).
 */
export function TaskList({
  tasks,
  today,
  showProspect = false,
  showAssignee = false,
  testId,
}: {
  tasks: SalesTask[];
  today: string;
  showProspect?: boolean;
  showAssignee?: boolean;
  testId?: string;
}) {
  const [action, setAction] = useState<{
    task: SalesTask;
    kind: 'done' | 'reschedule' | 'cancel';
  } | null>(null);
  return (
    <>
      <ul className="flex flex-col divide-y divide-stone-100" data-testid={testId}>
        {tasks.map((t) => {
          const due = dueLabel(t.dueOn, today);
          const open = t.status === 'OPEN';
          return (
            <li
              key={t.id}
              className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
              data-testid={`task-${t.title}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 font-medium wrap-anywhere">
                  {open && (
                    <span
                      className={`mr-2 text-sm ${dueClass[due.tone]}`}
                      data-testid="task-due-label"
                    >
                      {due.text}
                    </span>
                  )}
                  {t.title}
                </p>
                {open && (
                  <div className="flex shrink-0 gap-3 text-sm">
                    <button
                      type="button"
                      className="font-medium text-emerald-800 hover:underline"
                      onClick={() => setAction({ task: t, kind: 'done' })}
                      data-testid="task-done"
                    >
                      {tk.done}
                    </button>
                    <button
                      type="button"
                      className="text-stone-600 hover:underline"
                      onClick={() => setAction({ task: t, kind: 'reschedule' })}
                      data-testid="task-reschedule"
                    >
                      {tk.reschedule}
                    </button>
                    <button
                      type="button"
                      className="text-stone-600 hover:underline"
                      onClick={() => setAction({ task: t, kind: 'cancel' })}
                      data-testid="task-cancel"
                    >
                      {tk.cancel}
                    </button>
                  </div>
                )}
              </div>
              <p className="flex flex-wrap gap-x-3 text-xs text-stone-500">
                {showProspect && (
                  <Link
                    href={`/sales/prospects/${t.prospect.code}`}
                    className="font-medium text-stone-700 underline-offset-2 hover:underline"
                  >
                    {t.prospect.name}
                  </Link>
                )}
                {t.contact && <span>{t.contact.label}</span>}
                {showAssignee && <span>{tk.assignedTo(t.assignee.name)}</span>}
                {!open && (
                  <span>
                    {tk.closedBy(
                      salesCs.taskStatus[t.status],
                      t.closedBy ?? '',
                      salesDateTime(t.closedAt),
                    )}
                  </span>
                )}
              </p>
              {t.note && <p className="text-sm text-stone-600 wrap-anywhere">{t.note}</p>}
              {t.result && <p className="text-sm text-stone-700 wrap-anywhere">{t.result}</p>}
            </li>
          );
        })}
      </ul>
      {action && (
        <TaskActionDialog
          key={`${action.task.id}-${action.kind}`}
          {...action}
          today={today}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}

function TaskActionDialog({
  task,
  kind,
  today,
  onClose,
}: {
  task: SalesTask;
  kind: 'done' | 'reschedule' | 'cancel';
  today: string;
  onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [dueOn, setDueOn] = useState(task.dueOn < today ? today : task.dueOn);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, send } = useSalesSend();
  const title =
    kind === 'done' ? tk.doneTitle : kind === 'reschedule' ? tk.rescheduleTitle : tk.cancelTitle;
  return (
    <FormDialog
      open
      title={`${title}: ${task.title}`}
      submitLabel={kind === 'done' ? tk.done : kind === 'reschedule' ? tk.reschedule : tk.cancel}
      busy={busy}
      testId="task-action-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={onClose}
      onSubmit={() => {
        setInvalid(null);
        const base = `admin/sales/tasks/${task.id}`;
        if (kind === 'done') {
          return void send(
            `${base}/done`,
            { revision: task.revision, result: text.trim() || null },
            onClose,
          );
        }
        if (kind === 'reschedule') {
          if (!dueOn || dueOn < today) return setInvalid(tk.dueInPast);
          return void send(
            `${base}/reschedule`,
            { revision: task.revision, dueOn, reason: text.trim() || null },
            onClose,
          );
        }
        if (text.trim().length < 3) return setInvalid(salesCs.invalid);
        void send(`${base}/cancel`, { revision: task.revision, reason: text.trim() }, onClose);
      }}
    >
      {kind === 'done' && <p className="text-xs text-stone-500">{tk.doneNote}</p>}
      {kind === 'reschedule' && (
        <FormField id={`${id}-due`} label={tk.newDue}>
          <input
            id={`${id}-due`}
            type="date"
            min={today}
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            className={fieldClass(false)}
            data-testid="task-new-due"
          />
        </FormField>
      )}
      <FormField
        id={`${id}-text`}
        label={
          kind === 'done'
            ? tk.result
            : kind === 'reschedule'
              ? tk.rescheduleReason
              : tk.cancelReason
        }
      >
        <input
          id={`${id}-text`}
          maxLength={kind === 'done' ? 1000 : 500}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={fieldClass(false)}
          data-testid="task-action-text"
        />
      </FormField>
    </FormDialog>
  );
}
