'use client';

import { hotelDetailSchema, type FulfillmentSiteOption } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import {
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  useAttempt,
  useFocusFirstError,
} from '@/components/catalog/form-kit';
import { orderErrorText } from '@/components/dispatch/order-errors';
import { buttonClass, Card } from '@/components/ui';
import { hotelsCs } from '@/i18n/cs/hotels';
import { apiSend } from '@/lib/client-api';

const t = hotelsCs.form;
const FIELDS = [
  'name',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'countryCode',
  'contactName',
  'contactPhone',
  'contactEmail',
  'fulfillmentSiteId',
] as const;
type FieldName = (typeof FIELDS)[number];

/** Nový hotel (hotels:manage): one delivery address, contact and an explicit fulfilment site. */
export function HotelForm({ sites }: { sites: FulfillmentSiteOption[] }) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [v, setV] = useState<Record<FieldName, string>>(
    Object.fromEntries(FIELDS.map((f) => [f, ''])) as Record<FieldName, string>,
  );
  const [errors, setErrors] = useState<Partial<Record<FieldName, string | null>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Partial<Record<FieldName, string | null>> = {};
    for (const f of FIELDS) if (f !== 'addressLine2' && !v[f].trim()) next[f] = t.required;
    if (v.countryCode && !/^[A-Z]{2}$/.test(v.countryCode.trim()))
      next.countryCode = t.countryInvalid;
    if (v.contactPhone && !/^\+?[0-9 ()/-]{6,30}$/.test(v.contactPhone.trim()))
      next.contactPhone = t.phoneInvalid;
    if (v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail.trim()))
      next.contactEmail = t.emailInvalid;
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return focusError();
    const body = {
      ...Object.fromEntries(FIELDS.map((f) => [f, v[f].trim()])),
      addressLine2: v.addressLine2.trim() || null,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/hotels', hotelDetailSchema, { requestId, ...body }),
    );
    if (result.ok) router.push(`/hotels/${result.value.code}`);
    else if (result.error) setFormError(orderErrorText(result.error));
  }

  const input = (name: FieldName, label: string, opts: { help?: string; type?: string } = {}) => (
    <FormField id={`${id}-${name}`} label={label} help={opts.help} error={errors[name]}>
      <input
        id={`${id}-${name}`}
        name={name}
        type={opts.type ?? 'text'}
        value={v[name]}
        maxLength={name === 'countryCode' ? 2 : 200}
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
  );

  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4"
        data-testid="hotel-form"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {input('name', t.name)}
          <FormField
            id={`${id}-site`}
            label={t.site}
            help={t.siteHelp}
            error={errors.fulfillmentSiteId}
          >
            <select
              id={`${id}-site`}
              name="fulfillmentSiteId"
              value={v.fulfillmentSiteId}
              onChange={(e) => setV({ ...v, fulfillmentSiteId: e.target.value })}
              aria-invalid={!!errors.fulfillmentSiteId}
              aria-describedby={describedBy(`${id}-site`, true, !!errors.fulfillmentSiteId)}
              className={fieldClass(!!errors.fulfillmentSiteId)}
            >
              <option value="">{t.choose}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </FormField>
          {input('addressLine1', t.addressLine1)}
          {input('addressLine2', t.addressLine2)}
          {input('postalCode', t.postalCode)}
          {input('city', t.city)}
          {input('countryCode', t.country, { help: t.countryHelp })}
          {input('contactName', t.contactName)}
          {input('contactPhone', t.contactPhone, { type: 'tel' })}
          {input('contactEmail', t.contactEmail, { type: 'email' })}
        </div>
        <ErrorSummary errors={errors} formError={formError} />
        <div>
          <button
            type="submit"
            disabled={busy || sites.length === 0}
            className={buttonClass.primary}
          >
            {t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
