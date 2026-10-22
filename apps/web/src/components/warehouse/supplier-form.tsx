'use client';

import { supplierDetailSchema, supplierSchema, type SupplierDetail } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import {
  ConfirmDialog,
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  reasonError,
  ReasonField,
  useAttempt,
  useFocusFirstError,
} from '@/components/catalog/form-kit';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { apiErrorText } from './supplier-document-upload';

const s = warehouseCs.suppliers;

const FIELDS = [
  'name',
  'companyId',
  'vatId',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'countryCode',
  'contactName',
  'contactPhone',
  'contactEmail',
  'note',
] as const;
type FieldName = (typeof FIELDS)[number];
type Values = Record<FieldName, string>;

const MAX: Record<FieldName, number> = {
  name: 120,
  companyId: 32,
  vatId: 32,
  addressLine1: 200,
  addressLine2: 200,
  postalCode: 20,
  city: 120,
  countryCode: 2,
  contactName: 160,
  contactPhone: 30,
  contactEmail: 254,
  note: 1000,
};

function valuesOf(x: SupplierDetail | null): Values {
  return {
    name: x?.name ?? '',
    companyId: x?.companyId ?? '',
    vatId: x?.vatId ?? '',
    addressLine1: x?.address.addressLine1 ?? '',
    addressLine2: x?.address.addressLine2 ?? '',
    postalCode: x?.address.postalCode ?? '',
    city: x?.address.city ?? '',
    countryCode: x?.address.countryCode ?? '',
    contactName: x?.contact?.name ?? '',
    contactPhone: x?.contact?.phone ?? '',
    contactEmail: x?.contact?.email ?? '',
    note: x?.note ?? '',
  };
}

function validate(v: Values): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {};
  if (!v.name.trim()) e.name = s.required;
  if (v.countryCode.trim() && !/^[A-Z]{2}$/.test(v.countryCode.trim()))
    e.countryCode = s.countryInvalid;
  if (v.contactPhone.trim() && !/^\+?[0-9 ()/-]{6,30}$/.test(v.contactPhone.trim()))
    e.contactPhone = s.phoneInvalid;
  if (v.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail.trim()))
    e.contactEmail = s.emailInvalid;
  return e;
}

/**
 * Nový dodavatel / Úprava dodavatele (doc 033): only the name is required; identification, address
 * and contact are separate sections. A correction is saved as the next version with a reason,
 * based on the version that was loaded (a newer one is refused by the API, never overwritten).
 */
export function SupplierEditor({ supplier }: { supplier: SupplierDetail | null }) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [initial] = useState(() => valuesOf(supplier));
  const [v, setV] = useState<Values>(initial);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldName | 'reason', string | null>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { busy, run } = useAttempt();
  const dirty = !done && (FIELDS.some((f) => v[f] !== initial[f]) || reason.trim() !== '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Partial<Record<FieldName | 'reason', string | null>> = validate(v);
    if (supplier) next.reason = reasonError(reason);
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return focusError();
    const details = Object.fromEntries(
      FIELDS.map((f) => [f, v[f].trim() === '' ? null : v[f].trim()]),
    ) as Record<FieldName, string | null>;
    if (!supplier) {
      const result = await run(JSON.stringify(details), (requestId) =>
        apiSend('POST', 'admin/suppliers', supplierSchema, { requestId, ...details }),
      );
      if (result.ok) {
        setDone(true);
        router.push(`/warehouse/suppliers/${result.value.id}?created=1`);
      } else if (result.error) setFormError(apiErrorText(result.error));
      return;
    }
    const body = { revision: supplier.revision, ...details, reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/suppliers/${supplier.id}/revisions`, supplierDetailSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setDone(true);
      router.push(`/warehouse/suppliers/${supplier.id}?saved=1`);
    } else if (result.error) setFormError(apiErrorText(result.error));
  }

  const input = (
    name: FieldName,
    label: string,
    opts: { help?: string; type?: string; wide?: boolean } = {},
  ) => (
    <div className={opts.wide ? 'sm:col-span-2' : undefined}>
      <FormField id={`${id}-${name}`} label={label} help={opts.help} error={errors[name]}>
        <input
          id={`${id}-${name}`}
          name={name}
          type={opts.type ?? 'text'}
          value={v[name]}
          maxLength={MAX[name]}
          autoComplete="off"
          onChange={(e) =>
            setV({
              ...v,
              [name]: name === 'countryCode' ? e.target.value.toUpperCase() : e.target.value,
            })
          }
          aria-invalid={!!errors[name]}
          aria-describedby={describedBy(`${id}-${name}`, !!opts.help, !!errors[name])}
          className={fieldClass(!!errors[name])}
        />
      </FormField>
    </div>
  );

  const section = (title: string, testId: string, children: React.ReactNode) => (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend className="mb-3 text-base font-semibold">{title}</legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );

  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-8"
        data-testid="supplier-form"
      >
        {supplier && <p className="text-sm text-stone-600">{s.editHelp}</p>}
        {section(
          s.sectionIdentity,
          'section-identity',
          <>
            {input('name', s.name, { wide: true })}
            {input('companyId', s.companyId, { help: s.companyIdHelp })}
            {input('vatId', s.vatId, { help: s.vatIdHelp })}
          </>,
        )}
        {section(
          s.sectionAddress,
          'section-address',
          <>
            {input('addressLine1', s.addressLine1, { wide: true })}
            {input('addressLine2', s.addressLine2, { wide: true })}
            {input('postalCode', s.postalCode)}
            {input('city', s.city)}
            {input('countryCode', s.country, { help: s.countryHelp })}
          </>,
        )}
        {section(
          s.sectionContact,
          'section-contact',
          <>
            {input('contactName', s.contactName, { wide: true })}
            {input('contactPhone', s.contactPhone, { type: 'tel' })}
            {input('contactEmail', s.contactEmail, { type: 'email' })}
          </>,
        )}
        <FormField id={`${id}-note`} label={s.note} help={s.noteHelp}>
          <textarea
            id={`${id}-note`}
            name="note"
            rows={3}
            value={v.note}
            maxLength={MAX.note}
            onChange={(e) => setV({ ...v, note: e.target.value })}
            aria-describedby={`${id}-note-help`}
            className={fieldClass(false)}
          />
        </FormField>
        {supplier && (
          <ReasonField
            id={`${id}-reason`}
            value={reason}
            onChange={setReason}
            error={errors.reason}
          />
        )}
        <ErrorSummary errors={errors} formError={formError} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {supplier ? s.save : s.createSubmit}
          </button>
          {supplier && (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={() => router.push(`/warehouse/suppliers/${supplier.id}`)}
            >
              {s.cancel}
            </button>
          )}
        </div>
        <UnsavedChangesGuard dirty={dirty && !busy} onDiscard={() => setDone(true)} />
      </form>
    </Card>
  );
}

export function ArchiveSupplierButton({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen(true)}
        data-testid="archive-supplier"
      >
        {s.archive}
      </button>
      <ConfirmDialog
        open={open}
        title={s.archiveTitle}
        confirmLabel={s.archive}
        danger
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          const result = await run(id, (requestId) =>
            apiSend('POST', `admin/suppliers/${id}/archive`, supplierSchema, { requestId }),
          );
          if (result.ok) {
            setOpen(false);
            router.refresh();
          } else if (result.error) setError(apiErrorText(result.error));
        }}
        testId="archive-supplier-dialog"
      >
        <p>{s.archiveText}</p>
        {error && <p className="text-red-700">{error}</p>}
      </ConfirmDialog>
    </>
  );
}
