'use client';

import type { SalesTask } from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { salesCs } from '@/i18n/cs/sales';
import { FormDialog } from './sales-dialog';
import { dueClass, dueLabel, salesDateTime } from './sales-format';
import { dialogError, useSalesSend } from './use-sales-send';

const tk = salesCs.task;
type Ref = { id: string; label: string };
type Kind = 'edit' | 'done' | 'reschedule' | 'cancel';

/**
 * Tasks with their actions: edit (title, note, contact; the assignee for sales:manage), done (an
 * optional result — never a stage change), reschedule and cancel (with a reason). `showProspect`
 * for lists across prospects (overview, Úkoly). Editing needs the prospect's `contacts` (detail).
 * `assignees`: the people a task may be given to (sales:manage only; else no choice is offered).
 */
export function TaskList({
  tasks,
  today,
  showProspect = false,
  showAssignee = false,
  contacts,
  assignees = null,
  testId,
}: {
  tasks: SalesTask[];
  today: string;
  showProspect?: boolean;
  showAssignee?: boolean;
  contacts?: Ref[];
  assignees?: Ref[] | null;
  testId?: string;
}) {
  const [action, setAction] = useState<{ task: SalesTask; kind: Kind } | null>(null);
  // After a reload the dialog continues with the task's current revision (its fields stay).
  const current = action ? (tasks.find((t) => t.id === action.task.id) ?? action.task) : null;
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
                    {contacts && (
                      <button
                        type="button"
                        className="text-stone-600 hover:underline"
                        onClick={() => setAction({ task: t, kind: 'edit' })}
                        data-testid="task-edit"
                      >
                        {tk.edit}
                      </button>
                    )}
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
      {action && current && action.kind === 'edit' && (
        <TaskEditDialog
          key={`${action.task.id}-edit`}
          task={current}
          contacts={contacts ?? []}
          assignees={assignees}
          onClose={() => setAction(null)}
        />
      )}
      {action && current && action.kind !== 'edit' && (
        <TaskActionDialog
          key={`${action.task.id}-${action.kind}`}
          task={current}
          kind={action.kind}
          today={today}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}

/**
 * "Upravit úkol": title, note and contact; the assignee only for sales:manage (the API refuses it
 * otherwise). The due date moves through "Přesunout". On a conflict the typed values stay.
 */
function TaskEditDialog({
  task,
  contacts,
  assignees,
  onClose,
}: {
  task: SalesTask;
  contacts: Ref[];
  assignees: Ref[] | null;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const [v, setV] = useState({
    title: task.title,
    note: task.note ?? '',
    contactId: task.contact?.id ?? '',
    assigneeId: task.assignee.id,
  });
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, setError, send } = useSalesSend();
  const [reloading, startReload] = useTransition();
  const [reloaded, setReloaded] = useState(false);
  // A retired contact stays selectable only as the task's current one.
  const contactOptions =
    task.contact && !contacts.some((c) => c.id === task.contact!.id)
      ? [...contacts, task.contact]
      : contacts;
  const people =
    assignees && !assignees.some((a) => a.id === task.assignee.id)
      ? [{ id: task.assignee.id, label: task.assignee.name }, ...assignees]
      : assignees;
  return (
    <FormDialog
      open
      title={tk.editTitle}
      submitLabel={tk.editSave}
      busy={busy || reloading}
      testId="task-edit-dialog"
      error={
        invalid ??
        dialogError(error, {
          text: tk.changedKept,
          onReload: () => {
            setError(null);
            setReloaded(true);
            startReload(() => router.refresh());
          },
        })
      }
      onClose={onClose}
      onSubmit={() => {
        setInvalid(null);
        if (!v.title.trim()) return setInvalid(salesCs.invalid);
        void send(
          `admin/sales/tasks/${task.id}/update`,
          {
            revision: task.revision,
            title: v.title.trim(),
            note: v.note.trim() || null,
            contactId: v.contactId || null,
            // Without the right to choose (no `assignees`), always the assignee as the server has
            // it now — after a reload ADMIN may have taken the task over (Codex SALES45-R2).
            assigneeId: assignees ? v.assigneeId : task.assignee.id,
          },
          onClose,
        );
      }}
    >
      <p className="text-xs text-stone-500">{tk.editNote}</p>
      {reloaded && !reloading && !error && (
        <p className="text-xs text-emerald-800" data-testid="task-edit-reloaded">
          {tk.reloaded}
        </p>
      )}
      <FormField id={`${id}-title`} label={tk.what}>
        <input
          id={`${id}-title`}
          maxLength={200}
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.target.value })}
          className={fieldClass(false)}
          data-testid="task-edit-title"
        />
      </FormField>
      <FormField id={`${id}-contact`} label={tk.contact}>
        <select
          id={`${id}-contact`}
          value={v.contactId}
          onChange={(e) => setV({ ...v, contactId: e.target.value })}
          className={fieldClass(false)}
          data-testid="task-edit-contact"
        >
          <option value="">{salesCs.activity.noContact}</option>
          {contactOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </FormField>
      {people && (
        <FormField id={`${id}-assignee`} label={tk.assignee} help={tk.assigneeHelp}>
          <select
            id={`${id}-assignee`}
            value={v.assigneeId}
            onChange={(e) => setV({ ...v, assigneeId: e.target.value })}
            className={fieldClass(false)}
            data-testid="task-edit-assignee"
          >
            {people.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <FormField id={`${id}-note`} label={tk.note}>
        <textarea
          id={`${id}-note`}
          rows={3}
          maxLength={2000}
          value={v.note}
          onChange={(e) => setV({ ...v, note: e.target.value })}
          className={fieldClass(false)}
          data-testid="task-edit-note"
        />
      </FormField>
    </FormDialog>
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
      error={invalid ?? dialogError(error)}
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
