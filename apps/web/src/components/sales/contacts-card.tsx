'use client';

import type { SalesContact } from '@ayvo/types';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { Card, EmptyState } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { DialogError, useSalesSend } from './use-sales-send';
import { FormDialog } from './sales-dialog';

const c = salesCs.contact;
const PHONE = /^\+?[0-9 ()./-]{3,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Draft = {
  label: string;
  position: string;
  email: string;
  phone: string;
  note: string;
  isPrimary: boolean;
};
const draftOf = (x: SalesContact | null): Draft => ({
  label: x?.label ?? '',
  position: x?.position ?? '',
  email: x?.email ?? '',
  phone: x?.phone ?? '',
  note: x?.note ?? '',
  isPrimary: x?.isPrimary ?? false,
});

/** Kontakty (doc 034 §2): a person or a designation; one main contact; retired, never deleted. */
export function ContactsCard({ code, contacts }: { code: string; contacts: SalesContact[] }) {
  const active = contacts.filter((x) => !x.retired);
  const retired = contacts.filter((x) => x.retired);
  const [editing, setEditing] = useState<SalesContact | 'new' | null>(null);
  const [retiring, setRetiring] = useState<SalesContact | null>(null);
  return (
    <Card
      title={c.title}
      testId="contacts"
      action={
        <button
          type="button"
          className="font-medium text-stone-700 hover:underline"
          onClick={() => setEditing('new')}
          data-testid="add-contact"
        >
          {c.add}
        </button>
      }
    >
      {active.length === 0 ? (
        <EmptyState>{c.empty}</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100">
          {active.map((x) => (
            <li
              key={x.id}
              className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
              data-testid={`contact-${x.label}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium wrap-anywhere">
                  {x.label}
                  {x.position && (
                    <span className="font-normal text-stone-500"> · {x.position}</span>
                  )}
                  {x.isPrimary && (
                    <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                      {c.primaryBadge}
                    </span>
                  )}
                </p>
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    className="text-stone-600 hover:underline"
                    onClick={() => setEditing(x)}
                  >
                    {c.edit}
                  </button>
                  <button
                    type="button"
                    className="text-stone-600 hover:underline"
                    onClick={() => setRetiring(x)}
                  >
                    {c.retire}
                  </button>
                </div>
              </div>
              {(x.email || x.phone) && (
                <p className="flex flex-wrap gap-x-4 text-sm wrap-anywhere">
                  {x.email && (
                    <a
                      href={`mailto:${x.email}`}
                      className="text-stone-700 underline-offset-2 hover:underline"
                    >
                      {x.email}
                    </a>
                  )}
                  {x.phone && (
                    <a
                      href={`tel:${x.phone.replace(/[^+\d]/g, '')}`}
                      className="text-stone-700 underline-offset-2 hover:underline"
                    >
                      {x.phone}
                    </a>
                  )}
                </p>
              )}
              {x.note && <p className="text-sm text-stone-600 wrap-anywhere">{x.note}</p>}
            </li>
          ))}
        </ul>
      )}
      {retired.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-stone-500">
            {c.showRetired(retired.length)}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-stone-500">
            {retired.map((x) => (
              <li key={x.id} className="wrap-anywhere">
                {x.label} — {c.retiredBadge}: {x.retired!.reason} ({x.retired!.by})
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing && (
        <ContactDialog
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.revision}`}
          code={code}
          contact={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {retiring && (
        <RetireDialog
          key={retiring.id}
          code={code}
          contact={retiring}
          onClose={() => setRetiring(null)}
        />
      )}
    </Card>
  );
}

function ContactDialog({
  code,
  contact,
  onClose,
}: {
  code: string;
  contact: SalesContact | null;
  onClose: () => void;
}) {
  const id = useId();
  const [v, setV] = useState(() => draftOf(contact));
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, send } = useSalesSend();
  const field = (
    k: Exclude<keyof Draft, 'isPrimary'>,
    label: string,
    opts: { type?: string; help?: string; max: number },
  ) => (
    <FormField id={`${id}-${k}`} label={label} help={opts.help}>
      <input
        id={`${id}-${k}`}
        type={opts.type ?? 'text'}
        maxLength={opts.max}
        value={v[k]}
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
        className={fieldClass(false)}
        data-testid={`contact-${k}`}
      />
    </FormField>
  );
  return (
    <FormDialog
      open
      title={contact ? `${c.edit}: ${contact.label}` : c.add}
      submitLabel={c.save}
      busy={busy}
      testId="contact-dialog"
      error={invalid ?? <DialogError error={error} />}
      onClose={onClose}
      onSubmit={() => {
        setInvalid(null);
        if (!v.label.trim()) return setInvalid(salesCs.form.required);
        if (v.email.trim() && !EMAIL.test(v.email.trim()))
          return setInvalid(salesCs.form.emailInvalid);
        if (v.phone.trim() && !PHONE.test(v.phone.trim()))
          return setInvalid(salesCs.form.phoneInvalid);
        const body = {
          revision: contact?.revision ?? null,
          label: v.label.trim(),
          position: v.position.trim() || null,
          email: v.email.trim() || null,
          phone: v.phone.trim() || null,
          note: v.note.trim() || null,
          isPrimary: v.isPrimary,
        };
        void send(
          contact
            ? `admin/sales/prospects/${code}/contacts/${contact.id}/update`
            : `admin/sales/prospects/${code}/contacts`,
          body,
          onClose,
        );
      }}
    >
      {field('label', c.label, { help: c.labelHelp, max: 160 })}
      {field('position', c.position, { max: 120 })}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {field('email', c.email, { type: 'email', max: 254 })}
        {field('phone', c.phone, { type: 'tel', max: 40 })}
      </div>
      {field('note', c.note, { max: 1000 })}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={v.isPrimary}
          onChange={(e) => setV({ ...v, isPrimary: e.target.checked })}
        />
        {c.primary}
      </label>
    </FormDialog>
  );
}

function RetireDialog({
  code,
  contact,
  onClose,
}: {
  code: string;
  contact: SalesContact;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const { busy, error, send } = useSalesSend();
  return (
    <FormDialog
      open
      title={`${c.retireTitle}: ${contact.label}`}
      submitLabel={c.retire}
      busy={busy}
      testId="retire-contact-dialog"
      error={<DialogError error={error} />}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim().length < 3) return;
        void send(
          `admin/sales/prospects/${code}/contacts/${contact.id}/retire`,
          { revision: contact.revision, reason: reason.trim() },
          onClose,
        );
      }}
    >
      <p className="text-stone-600">{c.retireText}</p>
      <FormField id={`${id}-reason`} label={c.reason}>
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
