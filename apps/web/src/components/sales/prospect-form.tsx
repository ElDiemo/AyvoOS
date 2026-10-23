'use client';

import {
  duplicateHintSchema,
  prospectDetailSchema,
  type DuplicateHint,
  type ProspectDetail,
  type Salesperson,
} from '@ayvo/types';
import Link from 'next/link';
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
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { salesCs } from '@/i18n/cs/sales';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { isStale, salesErrorText } from './sales-format';

const f = salesCs.form;

const TEXT = [
  'name',
  'countryCode',
  'city',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'roomsEstimate',
  'accommodationType',
  'website',
  'source',
  'priority',
  'note',
  'ownerId',
  'contactLabel',
  'contactPosition',
  'contactEmail',
  'contactPhone',
] as const;
type Name = (typeof TEXT)[number];
type Values = Record<Name, string>;

const PHONE = /^\+?[0-9 ()./-]{3,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initialValues(p: ProspectDetail | null): Values {
  return {
    name: p?.name ?? '',
    countryCode: p?.countryCode ?? 'CZ',
    city: p?.city ?? '',
    addressLine1: p?.addressLine1 ?? '',
    addressLine2: p?.addressLine2 ?? '',
    postalCode: p?.postalCode ?? '',
    roomsEstimate: p?.roomsEstimate?.toString() ?? '',
    accommodationType: p?.accommodationType ?? '',
    website: p?.website ?? '',
    source: p?.source ?? '',
    priority: p?.priority ?? '',
    note: p?.note ?? '',
    ownerId: '',
    contactLabel: '',
    contactPosition: '',
    contactEmail: '',
    contactPhone: '',
  };
}

function validate(v: Values): Partial<Record<Name, string>> {
  const e: Partial<Record<Name, string>> = {};
  if (!v.name.trim()) e.name = f.required;
  if (!/^[A-Z]{2}$/.test(v.countryCode.trim())) e.countryCode = f.countryInvalid;
  if (v.roomsEstimate.trim() && !/^[1-9]\d{0,5}$/.test(v.roomsEstimate.trim())) {
    e.roomsEstimate = f.roomsInvalid;
  }
  const contact = v.contactPosition || v.contactEmail || v.contactPhone;
  if (contact && !v.contactLabel.trim()) e.contactLabel = f.required;
  if (v.contactEmail.trim() && !EMAIL.test(v.contactEmail.trim())) e.contactEmail = f.emailInvalid;
  if (v.contactPhone.trim() && !PHONE.test(v.contactPhone.trim())) e.contactPhone = f.phoneInvalid;
  return e;
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/**
 * "Nový zájemce" / "Upravit zájemce" (doc 034 §3): only the name and the country are required.
 * A possible duplicate needs an explicit "Přesto založit"; a newer version is never overwritten.
 * The input stays in the form after any error.
 */
export function ProspectForm({
  prospect,
  salespeople,
}: {
  prospect: ProspectDetail | null;
  /** Only for sales:manage (choosing the owner of a new prospect). */
  salespeople: Salesperson[] | null;
}) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [initial] = useState(() => initialValues(prospect));
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Partial<Record<Name, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateHint | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, run } = useAttempt();
  const dirty = !done && TEXT.some((k) => v[k] !== initial[k]);

  const set =
    (k: Name) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setV({ ...v, [k]: k === 'countryCode' ? e.target.value.toUpperCase() : e.target.value });
      if (k === 'name' || k === 'countryCode' || k === 'website' || k.startsWith('contact'))
        setDuplicates(null);
    };

  async function submit(acknowledgeDuplicates = false) {
    const next = validate(v);
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return focusError();
    const profile = {
      name: v.name.trim(),
      countryCode: v.countryCode.trim(),
      city: orNull(v.city),
      addressLine1: orNull(v.addressLine1),
      addressLine2: orNull(v.addressLine2),
      postalCode: orNull(v.postalCode),
      roomsEstimate: v.roomsEstimate.trim() ? Number(v.roomsEstimate.trim()) : null,
      accommodationType:
        (orNull(v.accommodationType) as ProspectDetail['accommodationType']) ?? null,
      website: orNull(v.website),
      source: orNull(v.source),
      priority: (orNull(v.priority) as ProspectDetail['priority']) ?? null,
      note: orNull(v.note),
    };
    if (prospect) {
      const body = { revision: prospect.revision, ...profile };
      const result = await run(JSON.stringify(body), (requestId) =>
        apiSend('POST', `admin/sales/prospects/${prospect.code}/update`, prospectDetailSchema, {
          requestId,
          ...body,
        }),
      );
      if (result.ok) {
        setDone(true);
        router.push(`/sales/prospects/${prospect.code}?saved=1`);
        router.refresh();
      } else if (result.error) {
        setStale(isStale(result.error));
        setFormError(salesErrorText(result.error));
      }
      return;
    }
    const body = {
      ...profile,
      ownerId: orNull(v.ownerId),
      contact: v.contactLabel.trim()
        ? {
            label: v.contactLabel.trim(),
            position: orNull(v.contactPosition),
            email: orNull(v.contactEmail),
            phone: orNull(v.contactPhone),
            note: null,
            isPrimary: true,
          }
        : null,
      acknowledgeDuplicates,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/sales/prospects', prospectDetailSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setDone(true);
      router.push(`/sales/prospects/${result.value.code}?created=1`);
    } else if (result.error) {
      const e = result.error;
      if (e instanceof ClientApiError && e.code === 'POSSIBLE_DUPLICATE') {
        const hint = duplicateHintSchema.safeParse(e.details);
        setDuplicates(hint.success ? hint.data : { accessible: [] });
      } else setFormError(salesErrorText(e));
    }
  }

  const input = (
    name: Name,
    label: string,
    opts: {
      help?: string;
      type?: string;
      wide?: boolean;
      max?: number;
      inputMode?: 'numeric';
      placeholder?: string;
    } = {},
  ) => (
    <div className={opts.wide ? 'sm:col-span-2' : undefined}>
      <FormField id={`${id}-${name}`} label={label} help={opts.help} error={errors[name]}>
        <input
          id={`${id}-${name}`}
          name={name}
          type={opts.type ?? 'text'}
          inputMode={opts.inputMode}
          value={v[name]}
          maxLength={opts.max}
          placeholder={opts.placeholder}
          autoComplete="off"
          onChange={set(name)}
          aria-invalid={!!errors[name]}
          aria-describedby={describedBy(`${id}-${name}`, !!opts.help, !!errors[name])}
          className={fieldClass(!!errors[name])}
        />
      </FormField>
    </div>
  );
  const select = (name: Name, label: string, options: [string, string][]) => (
    <FormField id={`${id}-${name}`} label={label}>
      <select
        id={`${id}-${name}`}
        name={name}
        value={v[name]}
        onChange={set(name)}
        className={fieldClass(false)}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </FormField>
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
        className="flex flex-col gap-8"
        data-testid="prospect-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        {section(
          f.sectionBasics,
          'section-basics',
          <>
            {input('name', f.name, { wide: true, max: 200 })}
            {input('countryCode', f.country, { help: f.countryHelp, max: 2 })}
            {input('city', f.city, { max: 120 })}
            {!prospect && salespeople && (
              <div className="sm:col-span-2">
                {select('ownerId', f.owner, [
                  ['', f.ownerMe],
                  ...salespeople.map((s): [string, string] => [s.id, `${s.name} (${s.email})`]),
                ])}
              </div>
            )}
          </>,
        )}
        {!prospect &&
          section(
            f.sectionContact,
            'section-contact',
            <>
              {input('contactLabel', salesCs.contact.label, {
                help: salesCs.contact.labelHelp,
                max: 160,
              })}
              {input('contactPosition', salesCs.contact.position, { max: 120 })}
              {input('contactEmail', salesCs.contact.email, { type: 'email', max: 254 })}
              {input('contactPhone', salesCs.contact.phone, { type: 'tel', max: 40 })}
            </>,
          )}
        {section(
          f.sectionDetails,
          'section-details',
          <>
            {input('roomsEstimate', f.rooms, { help: f.roomsHelp, inputMode: 'numeric', max: 6 })}
            {select('accommodationType', f.type, [
              ['', f.typeNone],
              ...Object.entries(salesCs.types),
            ])}
            {select('priority', f.priority, [
              ['', f.priorityNone],
              ['A', 'A'],
              ['B', 'B'],
              ['C', 'C'],
            ])}
            {input('source', f.source, { help: f.sourceHelp, max: 200 })}
            {input('website', f.website, { wide: true, max: 300, placeholder: 'https://' })}
          </>,
        )}
        {section(
          f.sectionPlace,
          'section-place',
          <>
            {input('addressLine1', f.addressLine1, { wide: true, max: 200 })}
            {input('addressLine2', f.addressLine2, { wide: true, max: 200 })}
            {input('postalCode', f.postalCode, { max: 20 })}
          </>,
        )}
        <FormField id={`${id}-note`} label={f.note}>
          <textarea
            id={`${id}-note`}
            name="note"
            rows={4}
            value={v.note}
            maxLength={4000}
            onChange={set('note')}
            className={fieldClass(false)}
          />
        </FormField>

        {duplicates && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
            data-testid="duplicate-warning"
          >
            <p className="font-semibold">{f.duplicateTitle}</p>
            <p>{f.duplicateText}</p>
            {duplicates.accessible.length > 0 && (
              <ul className="list-disc pl-5">
                {duplicates.accessible.map((d) => (
                  <li key={d.code}>
                    <Link href={`/sales/prospects/${d.code}`} className="underline" target="_blank">
                      {d.name}
                    </Link>
                    {d.city ? `, ${d.city}` : ''} · {d.owner} ·{' '}
                    {d.archived && `${salesCs.list.archivedBadge} · `}
                    {d.reasons.map((r) => f.duplicateReasons[r]).join(', ')}
                  </li>
                ))}
              </ul>
            )}
            <div>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={busy}
                onClick={() => void submit(true)}
                data-testid="create-anyway"
              >
                {f.createAnyway}
              </button>
            </div>
          </div>
        )}
        <ErrorSummary errors={errors} formError={formError} />
        {stale && prospect && (
          <p>
            <a
              href={`/sales/prospects/${prospect.code}/edit`}
              className="text-sm underline"
              data-testid="reload"
            >
              {f.reload}
            </a>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className={buttonClass.primary}
            data-testid="prospect-submit"
          >
            {busy ? f.saving : prospect ? f.save : f.create}
          </button>
          <Link
            href={prospect ? `/sales/prospects/${prospect.code}` : '/sales/prospects'}
            className={buttonClass.secondary}
          >
            {f.cancel}
          </Link>
        </div>
        <UnsavedChangesGuard dirty={dirty && !busy} onDiscard={() => setDone(true)} />
      </form>
    </Card>
  );
}
