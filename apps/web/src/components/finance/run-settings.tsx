'use client';

import {
  ADVANCE_BILLED_MONTHS,
  ARREARS_BILLED_MONTHS,
  billingRunSettingsPageSchema,
  testRunPlanSchema,
  type BillingRunSettings,
  type TestRunPlan,
} from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';

const t = financeCs.invoices.runSettings;
const errorText = (e: unknown) =>
  e instanceof ClientApiError && e.code === 'CONCURRENT_CHANGE'
    ? t.concurrent
    : e instanceof Error
      ? e.message
      : String(e);

/**
 * A new version of the run settings (doc 040 §11, §13), made from the one shown: every value is
 * chosen by the person — nothing is preselected when no version exists yet.
 */
export function RunSettingsForm({ current }: { current: BillingRunSettings | null }) {
  const router = useRouter();
  const attempt = useAttempt();
  const [issueDay, setIssueDay] = useState(current ? String(current.issueDay) : '');
  const [advance, setAdvance] = useState<string>(current?.advanceBilledMonth ?? '');
  const [arrears, setArrears] = useState<string>(current?.arrearsBilledMonth ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = 'flex min-w-0 flex-col gap-1 text-xs font-medium';
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      data-testid="run-settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const body = {
          expectedRevision: current?.revision ?? null,
          issueDay: Number(issueDay),
          advanceBilledMonth: advance,
          arrearsBilledMonth: arrears,
          reason: reason.trim(),
        };
        const r = await attempt.run(JSON.stringify(body), (requestId) =>
          apiSend('POST', 'admin/finance/billing/run-settings', billingRunSettingsPageSchema, {
            requestId,
            ...body,
          }),
        );
        if (r.ok) {
          setReason('');
          router.refresh();
        } else if (r.error) setError(errorText(r.error));
      }}
    >
      <label className={field}>
        {t.issueDay}
        <input
          required
          type="number"
          min={1}
          max={28}
          value={issueDay}
          onChange={(e) => setIssueDay(e.target.value)}
          className={inputClass}
          data-testid="run-settings-day"
        />
      </label>
      <label className={field}>
        {t.advance}
        <select
          required
          value={advance}
          onChange={(e) => setAdvance(e.target.value)}
          className={inputClass}
          data-testid="run-settings-advance"
        >
          <option value="">–</option>
          {ADVANCE_BILLED_MONTHS.map((v) => (
            <option key={v} value={v}>
              {t.billedMonth[v]}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {t.arrears}
        <select
          required
          value={arrears}
          onChange={(e) => setArrears(e.target.value)}
          className={inputClass}
          data-testid="run-settings-arrears"
        >
          <option value="">–</option>
          {ARREARS_BILLED_MONTHS.map((v) => (
            <option key={v} value={v}>
              {t.billedMonth[v]}
            </option>
          ))}
        </select>
      </label>
      <label className={`${field} sm:col-span-3`}>
        {t.reason}
        <input
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
          data-testid="run-settings-reason"
        />
      </label>
      <div className="sm:col-span-3">
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={attempt.busy}
          data-testid="run-settings-save"
        >
          {t.save}
        </button>
      </div>
      {error && (
        <div className="sm:col-span-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </form>
  );
}

/**
 * The plan of an issue month by the settings: its issue date and, per billing timing, the billed
 * month — each a link that opens the run with them filled in. Nothing is issued here.
 */
export function RunPlanForm() {
  const [issueMonth, setIssueMonth] = useState('');
  const [plan, setPlan] = useState<TestRunPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3" data-testid="run-plan">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setPlan(
              await apiGet(
                `admin/finance/invoices/test-run/plan?issueMonth=${issueMonth}`,
                testRunPlanSchema,
              ),
            );
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t.issueMonth}
          <input
            type="month"
            required
            value={issueMonth}
            onChange={(e) => {
              setIssueMonth(e.target.value);
              setPlan(null);
            }}
            className={inputClass}
            data-testid="run-plan-month"
          />
        </label>
        <button type="submit" className={buttonClass.secondary} data-testid="run-plan-load">
          {t.plan}
        </button>
      </form>
      {plan && plan.settingsRevision === null && (
        <p className="text-sm text-amber-800" data-testid="run-plan-missing">
          {t.missing}
        </p>
      )}
      {plan && plan.issuedOn && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="run-plan-groups">
          {plan.groups.map((g) => (
            <li key={g.billingTiming}>
              <Link
                href={`/finance/invoices/run?${new URLSearchParams({
                  month: g.billedMonth,
                  issuedOn: plan.issuedOn!,
                  timing: g.billingTiming,
                }).toString()}`}
                className="underline"
                data-testid={`run-plan-${g.billingTiming}`}
              >
                {t.group(t.timing[g.billingTiming]!, g.billedMonth, plan.issuedOn!)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
