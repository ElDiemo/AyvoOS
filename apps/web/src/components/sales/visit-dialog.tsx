'use client';

import type { ProspectDetail } from '@ayvo/types';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { salesCs } from '@/i18n/cs/sales';
import { FormDialog } from './sales-dialog';
import { salesNowLocal } from './sales-format';
import { dialogError, useSalesSend } from './use-sales-send';

type Contact = { id: string; label: string };
const v = salesCs.visit;
const a = salesCs.activity;
const tk = salesCs.task;
type StepKey = (typeof v.steps)[number]['key'];

/**
 * "Zahájit návštěvu": a short guide through a visit (who, the presentation box, today's cosmetics,
 * objections, the next step). It saves one ordinary MEETING activity whose content lists what was
 * covered — the same write as "Zapsat aktivitu" (one request id per attempt), optionally with the
 * next task; without one, the detail offers to plan the next step afterwards.
 */
export function VisitDialog({
  code,
  contacts,
  open,
  onClose,
  onSaved,
}: {
  code: string;
  contacts: Contact[];
  open: boolean;
  onClose: () => void;
  onSaved?: (detail: ProspectDetail) => void;
}) {
  const id = useId();
  const blank = () => ({
    occurredAt: salesNowLocal(),
    contactId: contacts.length === 1 ? contacts[0]!.id : '',
    done: {} as Partial<Record<StepKey, boolean>>,
    text: {} as Partial<Record<StepKey, string>>,
    notes: '',
    outcome: '',
    followUp: false,
    followTitle: '',
    followDue: '',
  });
  const [s, setS] = useState(blank);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, setError, send } = useSalesSend();
  /** Any edit clears the last refusal (it no longer describes the form). */
  const update = (patch: Partial<ReturnType<typeof blank>>) => {
    setInvalid(null);
    setS({ ...s, ...patch });
  };
  const today = salesNowLocal().slice(0, 10);
  const close = () => {
    setError(null);
    setInvalid(null);
    onClose();
  };
  const done = v.steps.filter((step) => s.done[step.key]).length;
  const content = () => {
    const l = v.contentLines;
    const lines: string[] = [];
    const text = (k: StepKey) => (s.text[k] ?? '').trim();
    if (s.done.who || text('who')) lines.push(`${l.who}: ${text('who') || '—'}`);
    if (s.done.box) lines.push(`${l.box}.`);
    if (s.done.now || text('now')) lines.push(`${l.now}: ${text('now') || '—'}`);
    if (s.done.objections || text('objections'))
      lines.push(`${l.objections}: ${text('objections') || '—'}`);
    if (s.done.next) lines.push(`${l.next}.`);
    if (s.notes.trim()) lines.push(`${l.notes}: ${s.notes.trim()}`);
    return lines.join('\n');
  };
  return (
    <FormDialog
      open={open}
      title={v.title}
      submitLabel={v.save}
      busy={busy}
      wide
      testId="visit-dialog"
      error={invalid ?? dialogError(error)}
      onClose={close}
      onSubmit={() => {
        setInvalid(null);
        const text = content();
        if (!text) return setInvalid(v.empty);
        if (text.length > 4000 || !s.occurredAt) return setInvalid(salesCs.invalid);
        if (s.occurredAt > salesNowLocal()) return setInvalid(a.inFuture);
        if (s.followUp && (!s.followTitle.trim() || !s.followDue))
          return setInvalid(salesCs.invalid);
        if (s.followUp && s.followDue < today) return setInvalid(tk.dueInPast);
        void send(
          `admin/sales/prospects/${code}/activities`,
          {
            kind: 'MEETING',
            occurredAt: s.occurredAt,
            contactId: s.contactId || null,
            content: text,
            outcome: s.outcome.trim() || null,
            followUp: s.followUp
              ? { title: s.followTitle.trim(), dueOn: s.followDue, contactId: s.contactId || null }
              : null,
          },
          (detail) => {
            setS(blank());
            close();
            onSaved?.(detail);
          },
        );
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-stone-600">{v.intro}</p>
        <span className="text-xs font-medium text-stone-500" data-testid="visit-progress">
          {v.progress(done, v.steps.length)}
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {v.steps.map((step, i) => (
          <li
            key={step.key}
            className="flex flex-col gap-2 rounded-md border border-stone-200 p-3"
            data-testid={`visit-step-${step.key}`}
          >
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!s.done[step.key]}
                onChange={(e) => update({ done: { ...s.done, [step.key]: e.target.checked } })}
                data-testid={`visit-done-${step.key}`}
              />
              <span className="flex flex-col">
                <span className="font-medium">
                  {i + 1}. {step.title}
                </span>
                <span className="text-xs text-stone-500">{step.help}</span>
              </span>
            </label>
            {step.field && (
              <input
                aria-label={step.field}
                placeholder={step.field}
                maxLength={500}
                value={s.text[step.key] ?? ''}
                onChange={(e) => update({ text: { ...s.text, [step.key]: e.target.value } })}
                className={fieldClass(false)}
                data-testid={`visit-text-${step.key}`}
              />
            )}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id={`${id}-at`} label={a.occurredAt}>
          <input
            id={`${id}-at`}
            type="datetime-local"
            value={s.occurredAt}
            max={salesNowLocal()}
            onChange={(e) => update({ occurredAt: e.target.value })}
            className={fieldClass(false)}
            data-testid="visit-at"
          />
        </FormField>
        <FormField id={`${id}-contact`} label={a.contact}>
          <select
            id={`${id}-contact`}
            value={s.contactId}
            onChange={(e) => update({ contactId: e.target.value })}
            className={fieldClass(false)}
            data-testid="visit-contact"
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
      <FormField id={`${id}-notes`} label={v.notes}>
        <textarea
          id={`${id}-notes`}
          rows={3}
          maxLength={2000}
          value={s.notes}
          onChange={(e) => update({ notes: e.target.value })}
          className={fieldClass(false)}
          data-testid="visit-notes"
        />
      </FormField>
      <FormField id={`${id}-outcome`} label={a.outcome}>
        <input
          id={`${id}-outcome`}
          maxLength={1000}
          value={s.outcome}
          placeholder={a.outcomePlaceholder}
          onChange={(e) => update({ outcome: e.target.value })}
          className={fieldClass(false)}
          data-testid="visit-outcome"
        />
      </FormField>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.followUp}
          onChange={(e) => update({ followUp: e.target.checked })}
          data-testid="visit-follow-up"
        />
        {a.followUp}
      </label>
      {s.followUp && (
        <div className="grid grid-cols-1 gap-4 rounded-md border border-stone-200 p-3 sm:grid-cols-[1fr_11rem]">
          <FormField id={`${id}-ft`} label={a.followUpTitle}>
            <input
              id={`${id}-ft`}
              maxLength={200}
              value={s.followTitle}
              onChange={(e) => update({ followTitle: e.target.value })}
              className={fieldClass(false)}
              data-testid="visit-follow-title"
            />
          </FormField>
          <FormField id={`${id}-fd`} label={a.followUpDue}>
            <input
              id={`${id}-fd`}
              type="date"
              min={today}
              value={s.followDue}
              onChange={(e) => update({ followDue: e.target.value })}
              className={fieldClass(false)}
              data-testid="visit-follow-due"
            />
          </FormField>
        </div>
      )}
    </FormDialog>
  );
}
