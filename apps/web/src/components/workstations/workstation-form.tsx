'use client';

import { managedWorkstationSchema, workstationCodeSchema, type ProductCategory } from '@ayvo/types';
import { useRouter } from 'next/navigation';
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
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiSend } from '@/lib/client-api';
import { workstationErrorText } from './workstation-errors';

const t = workstationsCs.manage;

/** Nové pracoviště (production:workstations_manage), at the active site. */
export function WorkstationForm({ categories }: { categories: ProductCategory[] }) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'LABELING' | 'FILLING' | ''>('');
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = {
      code: workstationCodeSchema.safeParse(code.trim()).success ? null : t.codeInvalid,
      name: name.trim() ? null : t.required,
      mode: mode ? null : t.required,
      category: mode === 'FILLING' && !category ? t.required : null,
      reason: reason.trim().length >= 3 ? null : t.reasonRequired,
    };
    setErrors(next);
    setFormError(null);
    setDone(null);
    if (Object.values(next).some(Boolean)) return focusError();
    const body = {
      code: code.trim(),
      name: name.trim(),
      mode: mode as 'LABELING' | 'FILLING',
      categoryCode: mode === 'FILLING' ? category : null,
      reason: reason.trim(),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/workstations', managedWorkstationSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setDone(t.created(result.value.code));
      setCode('');
      setName('');
      setMode('');
      setCategory('');
      setReason('');
      router.refresh();
    } else if (result.error) setFormError(workstationErrorText(result.error));
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card title={t.new}>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4"
        data-testid="workstation-form"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={f('name')} label={t.name} error={errors.name}>
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
          <FormField id={f('code')} label={t.code} help={t.codeHelp} error={errors.code}>
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
          <FormField id={f('mode')} label={t.modeLabel} error={errors.mode}>
            <select
              id={f('mode')}
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              aria-invalid={!!errors.mode}
              aria-describedby={describedBy(f('mode'), false, !!errors.mode)}
              className={fieldClass(!!errors.mode)}
            >
              <option value="">{t.choose}</option>
              <option value="LABELING">{workstationsCs.mode.LABELING}</option>
              <option value="FILLING">{workstationsCs.mode.FILLING}</option>
            </select>
          </FormField>
          {mode === 'FILLING' && (
            <FormField
              id={f('category')}
              label={t.category}
              help={t.categoryHelp}
              error={errors.category}
            >
              <select
                id={f('category')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                aria-invalid={!!errors.category}
                aria-describedby={describedBy(f('category'), true, !!errors.category)}
                className={fieldClass(!!errors.category)}
              >
                <option value="">{t.choose}</option>
                {categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        </div>
        <FormField id={f('reason')} label={t.reason} error={errors.reason}>
          <input
            id={f('reason')}
            value={reason}
            maxLength={500}
            placeholder={t.reasonPlaceholder}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={!!errors.reason}
            aria-describedby={describedBy(f('reason'), false, !!errors.reason)}
            className={fieldClass(!!errors.reason)}
          />
        </FormField>
        <ErrorSummary errors={errors} formError={formError} />
        {done && <SuccessNote>{done}</SuccessNote>}
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? t.saving : t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
