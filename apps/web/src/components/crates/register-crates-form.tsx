'use client';

import { crateRegistrationSchema, type CrateRegistration, type CrateType } from '@ayvo/types';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import {
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  SuccessNote,
  useAttempt,
  useFocusFirstError,
} from '@/components/catalog/form-kit';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { cratesCs } from '@/i18n/cs/crates';
import { apiSend } from '@/lib/client-api';
import { crateErrorText } from './crate-form-kit';
import { PrintLabelsForm } from './print-labels-form';

const t = cratesCs.new;

/** Evidovat nové bedny (idempotent per attempt); afterwards their QR labels can be printed. */
export function RegisterCratesForm({ crateTypes }: { crateTypes: CrateType[] }) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [typeCode, setTypeCode] = useState(crateTypes.length === 1 ? crateTypes[0]!.code : '');
  const [quantity, setQuantity] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<CrateRegistration | null>(null);
  const { busy, run } = useAttempt();

  if (done) {
    return (
      <div className="flex flex-col gap-6" data-testid="registration-done">
        <Card>
          <div className="flex flex-col gap-3">
            <SuccessNote>{t.done(done.code, done.quantity)}</SuccessNote>
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{t.codes}</p>
            <ul className="flex flex-wrap gap-2" data-testid="registered-codes">
              {done.crateCodes.map((code) => (
                <li key={code}>
                  <Link
                    href={`/production/crates/${code}`}
                    className="rounded bg-stone-100 px-2 py-1 font-mono text-sm underline-offset-2 hover:underline"
                  >
                    {code}
                  </Link>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`${buttonClass.secondary} self-start`}
              onClick={() => {
                setDone(null);
                setQuantity('');
              }}
            >
              {t.another}
            </button>
          </div>
        </Card>
        <PrintLabelsForm crateCodes={done.crateCodes} crateTypeCode={done.crateType.code} />
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = /^\d{1,4}$/.test(quantity.trim()) ? Number(quantity.trim()) : NaN;
    const next = {
      type: typeCode ? null : t.typeRequired,
      quantity: n >= 1 && n <= 1000 ? null : t.quantityInvalid,
    };
    setErrors(next);
    setFormError(null);
    if (next.type || next.quantity) return focusError();
    const body = { crateTypeCode: typeCode, quantity: n };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/crate-registrations', crateRegistrationSchema, { requestId, ...body }),
    );
    if (result.ok) setDone(result.value);
    else if (result.error) setFormError(crateErrorText(result.error));
  }

  if (crateTypes.length === 0) {
    return (
      <Card>
        <p className="text-sm text-stone-700" data-testid="no-crate-types">
          {t.noTypes}
        </p>
      </Card>
    );
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        data-testid="register-crates"
      >
        <UnsavedChangesGuard dirty={!!quantity && !busy} onDiscard={() => setQuantity('')} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={f('type')} label={t.type} help={t.typeHelp} error={errors.type}>
            <select
              id={f('type')}
              value={typeCode}
              onChange={(e) => setTypeCode(e.target.value)}
              aria-invalid={!!errors.type}
              aria-describedby={describedBy(f('type'), true, !!errors.type)}
              className={fieldClass(!!errors.type)}
            >
              <option value="">{t.choose}</option>
              {crateTypes.map((ct) => (
                <option key={ct.code} value={ct.code}>
                  {ct.name} ({ct.code}, {cratesCs.capacity(ct.capacity)})
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            id={f('quantity')}
            label={t.quantity}
            help={t.quantityHelp}
            error={errors.quantity}
          >
            <input
              id={f('quantity')}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              aria-invalid={!!errors.quantity}
              aria-describedby={describedBy(f('quantity'), true, !!errors.quantity)}
              className={fieldClass(!!errors.quantity)}
            />
          </FormField>
        </div>
        <ErrorSummary errors={errors} formError={formError} />
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? t.saving : t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
