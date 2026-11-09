'use client';

import {
  hotelProfileFieldsSchema,
  type HotelProfileFields,
  type PortalHotelProfile,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { cs } from '@/i18n/cs';

type Key = keyof HotelProfileFields;
type Values = Record<Key, string>;

const input =
  'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm outline-none focus:border-emerald-800 aria-[invalid=true]:border-red-600';

function initial(p: PortalHotelProfile): Values {
  return {
    addressLine1: p.address.addressLine1,
    addressLine2: p.address.addressLine2 ?? '',
    postalCode: p.address.postalCode,
    city: p.address.city,
    contactName: p.contact.name,
    contactPhone: p.contact.phone,
    contactEmail: p.contact.email,
    receivingContactName: p.receiving.contactName ?? '',
    receivingContactPhone: p.receiving.contactPhone ?? '',
    receivingContactEmail: p.receiving.contactEmail ?? '',
    deliveryNote: p.receiving.deliveryNote ?? '',
  };
}

/** A readable message for the first problem of each field. */
function problems(values: Values): Partial<Record<Key, string>> {
  const result = hotelProfileFieldsSchema.safeParse(values);
  if (result.success) return {};
  const out: Partial<Record<Key, string>> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as Key;
    if (out[key]) continue;
    const t = cs.profile.invalid;
    if (key === 'receivingContactName' && issue.code === 'custom') out[key] = t.needsName;
    else if (issue.code === 'too_small') out[key] = t.required;
    else if (issue.code === 'too_big') out[key] = t.tooLong;
    else if (key.endsWith('Email')) out[key] = t.email;
    else if (key.endsWith('Phone')) out[key] = t.phone;
    else out[key] = t.other;
  }
  return out;
}

function Field({
  name,
  value,
  error,
  onChange,
  type = 'text',
  autoComplete,
  maxLength,
  wide,
  multiline,
  help,
}: {
  name: Key;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  maxLength: number;
  wide?: boolean;
  multiline?: boolean;
  help?: string;
}) {
  const id = `field-${name}`;
  const described = [help ? `${id}-help` : '', error ? `${id}-error` : ''].join(' ').trim();
  const common = {
    id,
    name,
    value,
    maxLength,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described || undefined,
    className: input,
  };
  return (
    <div className={`flex flex-col gap-1 ${wide ? 'sm:col-span-2' : ''}`}>
      <label htmlFor={id} className="text-sm font-medium text-stone-800">
        {cs.profile.fields[name]}
      </label>
      {multiline ? (
        <textarea {...common} rows={4} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={type}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help && (
        <p id={`${id}-help`} className="text-xs text-stone-500">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function Fieldset({
  legend,
  help,
  children,
}: {
  legend: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div>
        <legend className="text-base font-semibold text-stone-900">{legend}</legend>
        <p className="text-xs text-stone-500">{help}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * The profile form: a normal form (labels, native keyboard order, Enter submits). It is checked
 * here with the same schema as portal-web and the core, then sent with the fingerprint of the
 * values it started from; a concurrent change is reported instead of being overwritten.
 */
export function ProfileForm({ profile }: { profile: PortalHotelProfile }) {
  const [values, setValues] = useState<Values>(() => initial(profile));
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const set = (key: Key) => (v: string) => setValues((old) => ({ ...old, [key]: v }));
  const field = (key: Key, maxLength: number, extra: Partial<Parameters<typeof Field>[0]> = {}) => (
    <Field
      name={key}
      value={values[key]}
      error={errors[key]}
      onChange={set(key)}
      maxLength={maxLength}
      {...extra}
    />
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    setStale(false);
    const found = problems(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/hotels/${profile.id}/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected: profile.fingerprint, profile: values }),
      }).catch(() => null);
      const data = (await res?.json().catch(() => ({}))) as {
        code?: string;
        fields?: string[];
      };
      if (res?.ok) {
        router.push(`/hotels/${profile.id}?saved=1`);
        router.refresh();
        return;
      }
      if (res?.status === 401) {
        router.replace('/login');
        return;
      }
      if (data?.code === 'INVALID_REQUEST' && data.fields?.length) {
        setErrors(
          Object.fromEntries(data.fields.map((f) => [f, cs.profile.invalid.other])) as Partial<
            Record<Key, string>
          >,
        );
      }
      setStale(data?.code === 'PROFILE_STALE');
      setFailure(cs.errors[String(data?.code)] ?? cs.errors.PORTAL_UNAVAILABLE!);
      requestAnimationFrame(() => summary.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const invalid = Object.keys(errors).length > 0;
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4" data-testid="profile-form">
      {(invalid || failure) && (
        <div
          ref={summary}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <p className="font-medium">{failure ?? cs.profile.summary}</p>
          {invalid && (
            <ul className="mt-1 list-disc pl-5">
              {(Object.keys(errors) as Key[]).map((k) => (
                <li key={k}>
                  <a href={`#field-${k}`} className="underline">
                    {cs.profile.fields[k]}: {errors[k]}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {stale && (
            <a
              href={`/hotels/${profile.id}/edit`}
              className="mt-2 inline-block font-medium underline"
            >
              {cs.profile.reload}
            </a>
          )}
        </div>
      )}
      <Fieldset legend={cs.profile.address} help={cs.profile.addressHelp}>
        {field('addressLine1', 200, { wide: true, autoComplete: 'address-line1' })}
        {field('addressLine2', 200, { wide: true, autoComplete: 'address-line2' })}
        {field('postalCode', 20, { autoComplete: 'postal-code' })}
        {field('city', 120, { autoComplete: 'address-level2' })}
      </Fieldset>
      <Fieldset legend={cs.profile.contact} help={cs.profile.contactHelp}>
        {field('contactName', 160, { wide: true, autoComplete: 'name' })}
        {field('contactPhone', 30, { type: 'tel', autoComplete: 'tel' })}
        {field('contactEmail', 254, { type: 'email', autoComplete: 'email' })}
      </Fieldset>
      <Fieldset legend={cs.profile.receiving} help={cs.profile.receivingHelp}>
        {field('receivingContactName', 160, { wide: true, autoComplete: 'off' })}
        {field('receivingContactPhone', 30, { type: 'tel', autoComplete: 'off' })}
        {field('receivingContactEmail', 254, { type: 'email', autoComplete: 'off' })}
        {field('deliveryNote', 500, { wide: true, multiline: true, help: cs.profile.noteHelp })}
      </Fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? cs.profile.saving : cs.profile.save}
        </button>
        <a
          href={`/hotels/${profile.id}`}
          className="rounded-lg px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-200"
        >
          {cs.profile.cancel}
        </a>
      </div>
    </form>
  );
}
