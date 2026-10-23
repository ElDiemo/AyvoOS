'use client';

import {
  ACTIVITY_KINDS,
  PROSPECT_STAGES,
  stageChangeNeedsReason,
  type ActivityKind,
  type ProspectDetail,
  type ProspectStage,
  type Salesperson,
} from '@ayvo/types';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { buttonClass } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { FormDialog } from './sales-dialog';
import { salesNowLocal } from './sales-format';
import { DialogError, useSalesSend } from './use-sales-send';

type Contact = { id: string; label: string };
const a = salesCs.activity;
const tk = salesCs.task;

const today = () => salesNowLocal().slice(0, 10);

/**
 * "Zapsat aktivitu": what happened and when (the real time, in Europe/Prague — e.g. yesterday's
 * call), optionally with the next task. Never changes the stage.
 */
export function ActivityDialog({
  code,
  contacts,
  open,
  onClose,
}: {
  code: string;
  contacts: Contact[];
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const blank = () => ({
    kind: 'CALL' as ActivityKind,
    occurredAt: salesNowLocal(),
    contactId: contacts.length === 1 ? contacts[0]!.id : '',
    content: '',
    outcome: '',
    followUp: false,
    followTitle: '',
    followDue: '',
  });
  const [v, setV] = useState(blank);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, setError, send } = useSalesSend();
  const close = () => {
    setError(null);
    setInvalid(null);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      title={a.title}
      submitLabel={a.save}
      busy={busy}
      wide
      testId="activity-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={close}
      onSubmit={() => {
        setInvalid(null);
        if (!v.content.trim() || !v.occurredAt) return setInvalid(salesCs.invalid);
        if (v.occurredAt > salesNowLocal()) return setInvalid(a.inFuture);
        if (v.followUp && (!v.followTitle.trim() || !v.followDue))
          return setInvalid(salesCs.invalid);
        if (v.followUp && v.followDue < today()) return setInvalid(tk.dueInPast);
        void send(
          `admin/sales/prospects/${code}/activities`,
          {
            kind: v.kind,
            occurredAt: v.occurredAt,
            contactId: v.contactId || null,
            content: v.content.trim(),
            outcome: v.outcome.trim() || null,
            followUp: v.followUp
              ? { title: v.followTitle.trim(), dueOn: v.followDue, contactId: v.contactId || null }
              : null,
          },
          () => {
            setV(blank());
            close();
          },
        );
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id={`${id}-kind`} label={a.kind}>
          <select
            id={`${id}-kind`}
            value={v.kind}
            onChange={(e) => setV({ ...v, kind: e.target.value as ActivityKind })}
            className={fieldClass(false)}
            data-testid="activity-kind"
          >
            {ACTIVITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {salesCs.kinds[k]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id={`${id}-at`} label={a.occurredAt} help={a.occurredAtHelp}>
          <input
            id={`${id}-at`}
            type="datetime-local"
            value={v.occurredAt}
            max={salesNowLocal()}
            onChange={(e) => setV({ ...v, occurredAt: e.target.value })}
            className={fieldClass(false)}
            data-testid="activity-at"
          />
        </FormField>
      </div>
      {(v.kind === 'EMAIL_SENT' || v.kind === 'EMAIL_RECEIVED') && (
        <p className="text-xs text-stone-500">{a.emailNote}</p>
      )}
      <FormField id={`${id}-contact`} label={a.contact}>
        <select
          id={`${id}-contact`}
          value={v.contactId}
          onChange={(e) => setV({ ...v, contactId: e.target.value })}
          className={fieldClass(false)}
          data-testid="activity-contact"
        >
          <option value="">{a.noContact}</option>
          {contacts.map((c) => (
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
          placeholder={a.contentPlaceholder}
          onChange={(e) => setV({ ...v, content: e.target.value })}
          className={fieldClass(false)}
          data-testid="activity-content"
        />
      </FormField>
      <FormField id={`${id}-outcome`} label={a.outcome}>
        <input
          id={`${id}-outcome`}
          maxLength={1000}
          value={v.outcome}
          placeholder={a.outcomePlaceholder}
          onChange={(e) => setV({ ...v, outcome: e.target.value })}
          className={fieldClass(false)}
          data-testid="activity-outcome"
        />
      </FormField>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={v.followUp}
          onChange={(e) => setV({ ...v, followUp: e.target.checked })}
          data-testid="activity-follow-up"
        />
        {a.followUp}
      </label>
      {v.followUp && (
        <div className="grid grid-cols-1 gap-4 rounded-md border border-stone-200 p-3 sm:grid-cols-[1fr_11rem]">
          <FormField id={`${id}-ft`} label={a.followUpTitle}>
            <input
              id={`${id}-ft`}
              maxLength={200}
              value={v.followTitle}
              onChange={(e) => setV({ ...v, followTitle: e.target.value })}
              className={fieldClass(false)}
              data-testid="follow-up-title"
            />
          </FormField>
          <FormField id={`${id}-fd`} label={a.followUpDue}>
            <input
              id={`${id}-fd`}
              type="date"
              min={today()}
              value={v.followDue}
              onChange={(e) => setV({ ...v, followDue: e.target.value })}
              className={fieldClass(false)}
              data-testid="follow-up-due"
            />
          </FormField>
        </div>
      )}
    </FormDialog>
  );
}

/** "Přidat úkol": what, when, with whom; ADMIN may give it to another sales administrator. */
export function TaskDialog({
  code,
  contacts,
  open,
  onClose,
}: {
  code: string;
  contacts: Contact[];
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const blank = () => ({ title: '', dueOn: '', contactId: '', note: '' });
  const [v, setV] = useState(blank);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, setError, send } = useSalesSend();
  const close = () => {
    setError(null);
    setInvalid(null);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      title={tk.title}
      submitLabel={tk.save}
      busy={busy}
      testId="task-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={close}
      onSubmit={() => {
        setInvalid(null);
        if (!v.title.trim() || !v.dueOn) return setInvalid(salesCs.invalid);
        if (v.dueOn < today()) return setInvalid(tk.dueInPast);
        void send(
          `admin/sales/prospects/${code}/tasks`,
          {
            title: v.title.trim(),
            dueOn: v.dueOn,
            contactId: v.contactId || null,
            assigneeId: null,
            note: v.note.trim() || null,
          },
          () => {
            setV(blank());
            close();
          },
        );
      }}
    >
      <FormField id={`${id}-title`} label={tk.what}>
        <input
          id={`${id}-title`}
          maxLength={200}
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.target.value })}
          className={fieldClass(false)}
          data-testid="task-title"
        />
      </FormField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id={`${id}-due`} label={tk.due}>
          <input
            id={`${id}-due`}
            type="date"
            min={today()}
            value={v.dueOn}
            onChange={(e) => setV({ ...v, dueOn: e.target.value })}
            className={fieldClass(false)}
            data-testid="task-due"
          />
        </FormField>
        <FormField id={`${id}-contact`} label={tk.contact}>
          <select
            id={`${id}-contact`}
            value={v.contactId}
            onChange={(e) => setV({ ...v, contactId: e.target.value })}
            className={fieldClass(false)}
          >
            <option value="">{a.noContact}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField id={`${id}-note`} label={tk.note}>
        <input
          id={`${id}-note`}
          maxLength={2000}
          value={v.note}
          onChange={(e) => setV({ ...v, note: e.target.value })}
          className={fieldClass(false)}
        />
      </FormField>
    </FormDialog>
  );
}

/** "Změnit fázi": a reason when going back or reopening; the reason of a lost deal. */
export function StageDialog({
  prospect,
  open,
  onClose,
}: {
  prospect: Pick<ProspectDetail, 'code' | 'stage' | 'revision'>;
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const st = salesCs.stageDialog;
  const [stage, setStage] = useState<ProspectStage>(prospect.stage);
  const [reason, setReason] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, setError, send } = useSalesSend();
  const needsReason = stageChangeNeedsReason(prospect.stage, stage);
  const close = () => {
    setError(null);
    setInvalid(null);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      title={st.title}
      submitLabel={st.save}
      busy={busy}
      testId="stage-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={close}
      onSubmit={() => {
        setInvalid(null);
        if (stage === prospect.stage) return setInvalid(salesCs.errors.STAGE_UNCHANGED!);
        if (needsReason && reason.trim().length < 3)
          return setInvalid(salesCs.errors.STAGE_REASON_REQUIRED!);
        if (stage === 'LOST' && lostReason.trim().length < 3)
          return setInvalid(salesCs.errors.LOST_REASON_REQUIRED!);
        void send(
          `admin/sales/prospects/${prospect.code}/stage`,
          {
            revision: prospect.revision,
            stage,
            reason: needsReason || reason.trim().length >= 3 ? reason.trim() : null,
            lostReason: stage === 'LOST' ? lostReason.trim() : null,
          },
          close,
        );
      }}
    >
      <p className="text-xs text-stone-500">{st.note}</p>
      <FormField id={`${id}-stage`} label={st.stage}>
        <select
          id={`${id}-stage`}
          value={stage}
          onChange={(e) => setStage(e.target.value as ProspectStage)}
          className={fieldClass(false)}
          data-testid="stage-select"
        >
          {PROSPECT_STAGES.map((s) => (
            <option key={s} value={s}>
              {salesCs.stages[s]}
            </option>
          ))}
        </select>
      </FormField>
      {stage === 'LOST' && (
        <FormField id={`${id}-lost`} label={st.lostReason}>
          <input
            id={`${id}-lost`}
            maxLength={500}
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            className={fieldClass(false)}
            data-testid="stage-lost-reason"
          />
        </FormField>
      )}
      <FormField id={`${id}-reason`} label={st.reason} help={st.reasonHelp}>
        <input
          id={`${id}-reason`}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-required={needsReason}
          className={fieldClass(false)}
          data-testid="stage-reason"
        />
      </FormField>
    </FormDialog>
  );
}

/** "Předat obchodníkovi" (sales:manage). */
export function OwnerDialog({
  prospect,
  salespeople,
  open,
  onClose,
}: {
  prospect: Pick<ProspectDetail, 'code' | 'owner' | 'revision'>;
  salespeople: Salesperson[];
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const o = salesCs.ownerDialog;
  const [ownerId, setOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, setError, send } = useSalesSend();
  const close = () => {
    setError(null);
    onClose();
  };
  const others = salespeople.filter((s) => s.id !== prospect.owner.id);
  return (
    <FormDialog
      open={open}
      title={o.title}
      submitLabel={o.save}
      busy={busy}
      testId="owner-dialog"
      error={<DialogError error={error} />}
      onClose={close}
      onSubmit={() => {
        if (!ownerId) return;
        void send(
          `admin/sales/prospects/${prospect.code}/owner`,
          {
            revision: prospect.revision,
            ownerId,
            reason: reason.trim().length >= 3 ? reason.trim() : null,
          },
          close,
        );
      }}
    >
      <p className="text-xs text-stone-500">{o.note}</p>
      <FormField id={`${id}-owner`} label={o.owner}>
        <select
          id={`${id}-owner`}
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          className={fieldClass(false)}
          data-testid="owner-select"
        >
          <option value="" />
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.email})
            </option>
          ))}
        </select>
      </FormField>
      <FormField id={`${id}-reason`} label={o.reason}>
        <input
          id={`${id}-reason`}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={fieldClass(false)}
        />
      </FormField>
    </FormDialog>
  );
}

/** The quick actions at the top of the detail: activity, task, stage (and assignment for ADMIN). */
export function ProspectActions({
  prospect,
  contacts,
  salespeople,
}: {
  prospect: Pick<ProspectDetail, 'code' | 'stage' | 'revision' | 'owner'>;
  contacts: Contact[];
  salespeople: Salesperson[] | null;
}) {
  const [open, setOpen] = useState<'activity' | 'task' | 'stage' | 'owner' | null>(null);
  const d = salesCs.detail;
  return (
    <div className="flex flex-wrap gap-2" data-testid="prospect-actions">
      <button
        type="button"
        className={buttonClass.primary}
        onClick={() => setOpen('activity')}
        data-testid="record-activity"
      >
        {d.recordActivity}
      </button>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen('task')}
        data-testid="add-task"
      >
        {d.addTask}
      </button>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen('stage')}
        data-testid="change-stage"
      >
        {d.changeStage}
      </button>
      {salespeople && (
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => setOpen('owner')}
          data-testid="change-owner"
        >
          {d.changeOwner}
        </button>
      )}
      <ActivityDialog
        code={prospect.code}
        contacts={contacts}
        open={open === 'activity'}
        onClose={() => setOpen(null)}
      />
      <TaskDialog
        code={prospect.code}
        contacts={contacts}
        open={open === 'task'}
        onClose={() => setOpen(null)}
      />
      {/* Re-mounted per revision so the dialog starts from the current stage. */}
      <StageDialog
        key={`stage-${prospect.revision}`}
        prospect={prospect}
        open={open === 'stage'}
        onClose={() => setOpen(null)}
      />
      {salespeople && (
        <OwnerDialog
          key={`owner-${prospect.revision}`}
          prospect={prospect}
          salespeople={salespeople}
          open={open === 'owner'}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
