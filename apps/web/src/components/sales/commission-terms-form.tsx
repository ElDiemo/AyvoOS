'use client';

import { commissionTermsSchema, parseCommissionRate } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  describedBy,
  fieldClass,
  FormField,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = commissionsCs;
type Errors = Partial<
  Record<'initialRate' | 'initialMonths' | 'maintenanceRate' | 'reason' | 'confirm', string>
>;

/**
 * A new version of one salesperson's terms (ADMIN; doc 068 §4.1). Checked here as the server
 * checks it (refused, never rounded); the server's answer is the authority. One request id per
 * attempt, so a retry after a lost answer continues the same request.
 */
export function CommissionTermsForm({
  salespersonId,
  expectedVersion,
}: {
  salespersonId: string;
  expectedVersion: number;
}) {
  const router = useRouter();
  const { busy, run } = useAttempt();
  const [values, setValues] = useState({
    initialRate: '',
    initialMonths: '',
    maintenanceRate: '',
    reason: '',
    confirm: false,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function check(): Errors {
    const e: Errors = {};
    if (parseCommissionRate(values.initialRate) === null) e.initialRate = t.errors.rate;
    if (!/^\d+$/.test(values.initialMonths.trim()) || Number(values.initialMonths) < 1)
      e.initialMonths = t.errors.months;
    if (parseCommissionRate(values.maintenanceRate) === null) e.maintenanceRate = t.errors.rate;
    if (!values.reason.trim()) e.reason = t.errors.reason;
    if (!values.confirm) e.confirm = t.errors.confirm;
    return e;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaved(false);
    setFailure(null);
    const e = check();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const body = {
      salespersonId,
      expectedVersion,
      initialRate: values.initialRate.trim(),
      initialMonths: Number(values.initialMonths),
      maintenanceRate: values.maintenanceRate.trim(),
      reason: values.reason.trim(),
      confirm: true as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/sales/commission-terms', commissionTermsSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setSaved(true);
      setValues({
        initialRate: '',
        initialMonths: '',
        maintenanceRate: '',
        reason: '',
        confirm: false,
      });
      router.refresh();
      return;
    }
    if (!result.error) return;
    const err = result.error;
    const code = err instanceof ClientApiError ? err.code : undefined;
    setFailure(
      uncertain(err)
        ? t.errors.uncertain
        : ((code && (t.errors as Record<string, string>)[code]) ?? t.errors.failed),
    );
  }

  const input = (
    key: 'initialRate' | 'initialMonths' | 'maintenanceRate',
    id: string,
    help: boolean,
    mode: 'decimal' | 'numeric',
  ) => (
    <input
      id={id}
      inputMode={mode}
      autoComplete="off"
      className={fieldClass(Boolean(errors[key]))}
      value={values[key]}
      aria-invalid={errors[key] ? true : undefined}
      aria-describedby={describedBy(id, help, Boolean(errors[key]))}
      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      data-testid={`terms-${key}`}
    />
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" data-testid="terms-form">
      <p className="text-sm text-stone-600">{t.settings.appliesNew}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          id="terms-initial-rate"
          label={t.fields.initialRate}
          help={t.fields.rateHelp}
          error={errors.initialRate}
        >
          {input('initialRate', 'terms-initial-rate', true, 'decimal')}
        </FormField>
        <FormField
          id="terms-initial-months"
          label={t.fields.initialMonths}
          error={errors.initialMonths}
        >
          {input('initialMonths', 'terms-initial-months', false, 'numeric')}
        </FormField>
        <FormField
          id="terms-maintenance-rate"
          label={t.fields.maintenanceRate}
          help={t.fields.rateHelp}
          error={errors.maintenanceRate}
        >
          {input('maintenanceRate', 'terms-maintenance-rate', true, 'decimal')}
        </FormField>
      </div>
      <FormField id="terms-reason" label={t.fields.reason} error={errors.reason}>
        <textarea
          id="terms-reason"
          rows={2}
          maxLength={500}
          className={fieldClass(Boolean(errors.reason))}
          value={values.reason}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={describedBy('terms-reason', false, Boolean(errors.reason))}
          onChange={(e) => setValues((v) => ({ ...v, reason: e.target.value }))}
          data-testid="terms-reason"
        />
      </FormField>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.confirm}
          aria-invalid={errors.confirm ? true : undefined}
          aria-describedby={errors.confirm ? 'terms-confirm-error' : undefined}
          onChange={(e) => setValues((v) => ({ ...v, confirm: e.target.checked }))}
          data-testid="terms-confirm"
        />
        <span>{t.fields.confirm}</span>
      </label>
      {errors.confirm && (
        <p id="terms-confirm-error" className="text-xs font-medium text-red-700">
          {errors.confirm}
        </p>
      )}
      {failure && <ErrorNote>{failure}</ErrorNote>}
      {saved && (
        <p role="status" className="text-sm text-emerald-700" data-testid="terms-saved">
          {t.saved}
        </p>
      )}
      <div>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={busy}
          data-testid="terms-save"
        >
          {t.save}
        </button>
      </div>
    </form>
  );
}
