'use client';

import { catalogCodeSchema, crateTypeSchema, type ProductCategory } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiSend } from '@/lib/client-api';
import {
  catalogErrorText,
  describedBy,
  ErrorSummary,
  fieldClass,
  useFocusFirstError,
  FormField,
  labelClass,
  ReasonField,
  reasonError,
  useAttempt,
} from './form-kit';

const t = catalogCs.crateTypes;
const c = catalogCs.common;

/** Nový typ bedny: a definition (capacity is data the user enters), not a physical crate. */
export function CrateTypeForm({ categories }: { categories: ProductCategory[] }) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const dirty = !!(code || name || capacity || reason || chosen.length);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cap = /^[1-9]\d{0,3}$/.test(capacity.trim()) ? Number(capacity.trim()) : NaN;
    const next = {
      code: catalogCodeSchema.safeParse(code.trim()).success ? null : c.codeInvalid,
      name: name.trim() ? null : c.required,
      capacity: cap >= 1 && cap <= 1000 ? null : t.capacityInvalid,
      categories: chosen.length ? null : t.categoriesRequired,
      reason: reasonError(reason),
    };
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) {
      focusError();
      return;
    }
    const body = {
      code: code.trim(),
      name: name.trim(),
      capacity: cap,
      categoryCodes: [...chosen].sort(),
      reason: reason.trim(),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/catalog/crate-types', crateTypeSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setCode('');
      setName('');
      setCapacity('');
      setChosen([]);
      setReason('');
      router.push(
        `/production/catalog/crate-types?created=${encodeURIComponent(result.value.code)}`,
      );
      router.refresh();
    } else if (result.error) {
      setFormError(catalogErrorText(result.error));
    }
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        data-testid="crate-type-form"
      >
        <UnsavedChangesGuard dirty={dirty && !busy} onDiscard={() => setReason('')} />
        <p className="text-sm text-stone-600">{t.help}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={f('name')} label={c.name} error={errors.name}>
            <input
              id={f('name')}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy(f('name'), false, !!errors.name)}
              className={fieldClass(!!errors.name)}
            />
          </FormField>
          <FormField id={f('code')} label={c.code} help={c.codeHelp} error={errors.code}>
            <input
              id={f('code')}
              value={code}
              maxLength={40}
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-invalid={!!errors.code}
              aria-describedby={describedBy(f('code'), true, !!errors.code)}
              className={`${fieldClass(!!errors.code)} font-mono`}
            />
          </FormField>
          <FormField
            id={f('capacity')}
            label={t.capacity}
            help={t.capacityHelp}
            error={errors.capacity}
          >
            <input
              id={f('capacity')}
              inputMode="numeric"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              aria-invalid={!!errors.capacity}
              aria-describedby={describedBy(f('capacity'), true, !!errors.capacity)}
              className={fieldClass(!!errors.capacity)}
            />
          </FormField>
        </div>
        <fieldset
          className="flex flex-col gap-2"
          aria-invalid={!!errors.categories}
          aria-describedby={errors.categories ? f('cat-error') : undefined}
        >
          <legend className={labelClass}>{t.categories}</legend>
          {categories.map((cat) => (
            <label key={cat.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(cat.code)}
                onChange={(e) =>
                  setChosen((s) =>
                    e.target.checked ? [...s, cat.code] : s.filter((x) => x !== cat.code),
                  )
                }
              />
              {cat.name}
            </label>
          ))}
          {errors.categories && (
            <p id={f('cat-error')} className="text-xs font-medium text-red-700">
              {errors.categories}
            </p>
          )}
        </fieldset>
        <ReasonField id={f('reason')} value={reason} onChange={setReason} error={errors.reason} />
        <ErrorSummary errors={errors} formError={formError} />
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? c.saving : t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
