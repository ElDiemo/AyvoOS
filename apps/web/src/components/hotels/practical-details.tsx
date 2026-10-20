'use client';

import { hotelDetailSchema, type HotelPractical } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  ConfirmDialog,
  fieldClass,
  FormField,
  reasonError,
  ReasonField,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, Field, FieldList } from '@/components/ui';
import { hotelsCs } from '@/i18n/cs/hotels';
import { apiSend } from '@/lib/client-api';

const t = hotelsCs.detail;

/** Příjem zboží (doc 032): optional details for the staff; editable with a reason (hotels:manage). */
export function PracticalDetails({
  hotel,
  practical,
  canEdit,
}: {
  hotel: string;
  practical: HotelPractical;
  canEdit: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(practical.deliveryNote ?? '');
  const [name, setName] = useState(practical.receivingContact?.name ?? '');
  const [phone, setPhone] = useState(practical.receivingContact?.phone ?? '');
  const [email, setEmail] = useState(practical.receivingContact?.email ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const c = practical.receivingContact;

  async function save() {
    const invalid = reasonError(reason);
    const missingName =
      (phone.trim() || email.trim()) && !name.trim() ? t.receivingNameRequired : null;
    setError(invalid);
    setNameError(missingName);
    if (invalid || missingName) return;
    const body = {
      deliveryNote: note.trim() || null,
      receivingContactName: name.trim() || null,
      receivingContactPhone: phone.trim() || null,
      receivingContactEmail: email.trim() || null,
      reason: reason.trim(),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/hotels/${hotel}/practical`, hotelDetailSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      setReason('');
      router.refresh();
    } else if (result.error) setError(hotelsCs.form.required);
  }

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="hotel-practical">
      {practical.deliveryNote || c ? (
        <FieldList>
          {practical.deliveryNote && <Field label={t.deliveryNote}>{practical.deliveryNote}</Field>}
          {c && (
            <Field label={t.receivingContact}>
              {[c.name, c.phone, c.email].filter(Boolean).join(', ')}
            </Field>
          )}
        </FieldList>
      ) : (
        <p className="text-stone-500">{t.noPractical}</p>
      )}
      {canEdit && (
        <div>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setOpen(true)}
            data-testid="edit-practical"
          >
            {t.editPractical}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={open}
        title={t.practicalTitle}
        confirmLabel={t.practicalSave}
        busy={busy}
        onConfirm={save}
        onCancel={() => setOpen(false)}
        testId="practical-dialog"
      >
        <p>{t.practicalText}</p>
        <div className="mt-3 flex flex-col gap-3">
          <FormField id={`${id}-note`} label={t.deliveryNote}>
            <textarea
              id={`${id}-note`}
              className={fieldClass(false)}
              value={note}
              maxLength={500}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
          <FormField
            id={`${id}-name`}
            label={`${t.receivingContact} – ${t.receivingName}`}
            error={nameError}
          >
            <input
              id={`${id}-name`}
              className={fieldClass(!!nameError)}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField id={`${id}-phone`} label={t.receivingPhone}>
            <input
              id={`${id}-phone`}
              className={fieldClass(false)}
              value={phone}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
            />
          </FormField>
          <FormField id={`${id}-email`} label={t.receivingEmail}>
            <input
              id={`${id}-email`}
              className={fieldClass(false)}
              value={email}
              type="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
