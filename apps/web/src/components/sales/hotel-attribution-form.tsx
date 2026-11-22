'use client';

import { hotelAttributionSchema, previousMonth, type HotelAttribution } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  describedBy,
  fieldClass,
  FormField,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, Notice } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateCs } from '@/i18n/cs/format';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { monthCs, termsLine } from './commission-format';

const t = commissionsCs.attribution;
const MANUAL = 'MANUAL';
const NOBODY = 'NOBODY';
type Errors = Partial<
  Record<'salesperson' | 'month' | 'confirmMonth' | 'planned' | 'reason' | 'confirm', string>
>;

/**
 * The hotel card's attribution (doc 068 §12.1; sales:manage + hotels:read). The first
 * attribution: a signed contract prefills the salesperson and the month of its start, which the
 * admin confirms explicitly (another month with a reason); without a contract both are entered by
 * hand. Later: a change of salesperson from a month; the first paid month never changes. The
 * server checks everything again and is the authority.
 */
export function HotelAttributionForm({ data }: { data: HotelAttribution }) {
  const router = useRouter();
  const { busy, run } = useAttempt();
  const first = data.revision === 0;
  const single = data.candidates.length === 1 ? data.candidates[0]! : null;
  const [source, setSource] = useState<string>(
    first
      ? single
        ? `${single.draftCode}#${single.revision}`
        : data.candidates.length
          ? ''
          : MANUAL
      : MANUAL,
  );
  const candidate = data.candidates.find((c) => `${c.draftCode}#${c.revision}` === source) ?? null;
  const [salesperson, setSalesperson] = useState<string>(single?.prefilledSalesperson?.id ?? '');
  const [month, setMonth] = useState<string>(single?.prefilledMonth ?? '');
  const [confirmMonth, setConfirmMonth] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function pickSource(next: string) {
    setSource(next);
    const c = data.candidates.find((x) => `${x.draftCode}#${x.revision}` === next);
    setSalesperson(c?.prefilledSalesperson?.id ?? '');
    setMonth(c?.prefilledMonth ?? '');
    setConfirmMonth(false);
  }

  const chosen = data.salespeople.find((s) => s.id === salesperson) ?? null;
  const changed =
    candidate?.prefilledSalesperson &&
    salesperson &&
    salesperson !== candidate.prefilledSalesperson.id;
  const differs = candidate && month && month !== candidate.prefilledMonth;
  // A change before an already planned later revision ends where the plan starts (review 1b-R1).
  const [ackPlanned, setAckPlanned] = useState(false);
  const planned = first
    ? undefined
    : data.history
        .filter(
          (r) => r.supersededBy === null && /^\d{4}-\d{2}$/.test(month) && r.effectiveFrom > month,
        )
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaved(false);
    setFailure(null);
    const e: Errors = {};
    if (!salesperson) e.salesperson = t.errors.salesperson;
    if (!/^\d{4}-\d{2}$/.test(month)) e.month = t.errors.month;
    if (first && !confirmMonth) e.confirmMonth = t.errors.confirmMonth;
    if (planned && !ackPlanned) e.planned = t.errors.planned;
    if (!reason.trim()) e.reason = t.errors.reason;
    if (!confirm) e.confirm = t.errors.confirm;
    if (first && !source) e.salesperson = e.salesperson ?? t.errors.salesperson;
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const body = {
      expectedRevision: data.revision,
      salespersonId: salesperson === NOBODY ? null : salesperson,
      source: candidate ? ('CONTRACT' as const) : ('MANUAL' as const),
      ...(candidate
        ? { contractDraftCode: candidate.draftCode, contractRevision: candidate.revision }
        : {}),
      ...(first
        ? { commissionStart: month, confirmCommissionStart: true }
        : { effectiveFrom: month, ...(planned ? { acknowledgePlannedLater: true } : {}) }),
      reason: reason.trim(),
      confirm: true as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/hotels/${data.hotel.code}/sales-attribution`, hotelAttributionSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setSaved(true);
      setReason('');
      setConfirm(false);
      setConfirmMonth(false);
      router.refresh();
      return;
    }
    if (!result.error) return;
    const code = result.error instanceof ClientApiError ? result.error.code : undefined;
    setFailure(
      uncertain(result.error)
        ? t.errors.uncertain
        : ((code && (t.errors as Record<string, string>)[code]) ?? t.errors.failed),
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-4"
      data-testid="attribution-form"
    >
      {first && data.candidates.length === 0 && (
        <p className="text-sm text-stone-600">{t.noSource}</p>
      )}
      {first && data.candidates.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t.source}</legend>
          {data.candidates.map((c) => {
            const key = `${c.draftCode}#${c.revision}`;
            return (
              <label key={key} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="attribution-source"
                  checked={source === key}
                  onChange={() => pickSource(key)}
                  data-testid={`attribution-source-${c.draftCode}`}
                />
                <span>
                  {t.candidate(
                    c.draftCode,
                    c.revision,
                    formatDateCs(c.signedOn),
                    formatDateCs(c.startOn),
                  )}
                  {c.prospectCode && <span className="text-stone-500"> · {c.prospectCode}</span>}
                  <span className="block text-xs text-stone-600">
                    {c.prefilledSalesperson ? t.offer(c.prefilledSalesperson.name) : t.noOffer}
                  </span>
                </span>
              </label>
            );
          })}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="attribution-source"
              checked={source === MANUAL}
              onChange={() => pickSource(MANUAL)}
              data-testid="attribution-source-manual"
            />
            <span>{t.sourceManual}</span>
          </label>
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="attribution-salesperson" label={t.salesperson} error={errors.salesperson}>
          <select
            id="attribution-salesperson"
            className={fieldClass(Boolean(errors.salesperson))}
            value={salesperson}
            aria-invalid={errors.salesperson ? true : undefined}
            aria-describedby={describedBy(
              'attribution-salesperson',
              false,
              Boolean(errors.salesperson),
            )}
            onChange={(e) => setSalesperson(e.target.value)}
            data-testid="attribution-salesperson"
          >
            <option value="">—</option>
            {data.salespeople.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NOBODY}>{t.nobody}</option>
          </select>
        </FormField>
        <FormField
          id="attribution-month"
          label={first ? t.firstMonth : t.effectiveFrom}
          help={first ? undefined : t.effectiveHelp}
          error={errors.month}
        >
          <input
            id="attribution-month"
            type="month"
            className={fieldClass(Boolean(errors.month))}
            value={month}
            aria-invalid={errors.month ? true : undefined}
            aria-describedby={describedBy('attribution-month', !first, Boolean(errors.month))}
            onChange={(e) => {
              setMonth(e.target.value);
              setConfirmMonth(false);
            }}
            data-testid="attribution-month"
          />
        </FormField>
      </div>
      {changed && <p className="text-xs text-amber-800">{t.changedFromOffer}</p>}
      {first && candidate && (
        <p className="text-xs text-stone-600" data-testid="attribution-from-contract">
          {t.fromContract(formatDateCs(candidate.startOn))}
          {differs && <strong className="block text-amber-800">{t.differs}</strong>}
        </p>
      )}
      {first && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmMonth}
            aria-invalid={errors.confirmMonth ? true : undefined}
            aria-describedby={errors.confirmMonth ? 'attribution-confirm-month-error' : undefined}
            onChange={(e) => setConfirmMonth(e.target.checked)}
            data-testid="attribution-confirm-month"
          />
          <span>
            {t.confirmMonth}
            {month && /^\d{4}-\d{2}$/.test(month) && <strong> {monthCs(month)}</strong>}
          </span>
        </label>
      )}
      {errors.confirmMonth && (
        <p id="attribution-confirm-month-error" className="text-xs font-medium text-red-700">
          {errors.confirmMonth}
        </p>
      )}
      {planned && (
        <div className="flex flex-col gap-2" data-testid="attribution-planned">
          <Notice>
            {t.plannedLater(
              monthCs(planned.effectiveFrom),
              planned.salesperson?.name ?? t.nobody,
              monthCs(previousMonth(planned.effectiveFrom)),
            )}
          </Notice>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={ackPlanned}
              aria-invalid={errors.planned ? true : undefined}
              aria-describedby={errors.planned ? 'attribution-planned-error' : undefined}
              onChange={(e) => setAckPlanned(e.target.checked)}
              data-testid="attribution-acknowledge-planned"
            />
            <span>{t.acknowledgePlanned(monthCs(planned.effectiveFrom))}</span>
          </label>
          {errors.planned && (
            <p id="attribution-planned-error" className="text-xs font-medium text-red-700">
              {errors.planned}
            </p>
          )}
        </div>
      )}
      {chosen && (
        <div className="text-sm" data-testid="attribution-terms">
          <span className="text-stone-600">{t.termsBound}: </span>
          {chosen.validTerms ? (
            chosen.validTerms.initialRate === null ? (
              t.termsHidden
            ) : (
              <strong>{termsLine(chosen.validTerms)}</strong>
            )
          ) : (
            <Notice>{t.missingBound}</Notice>
          )}
        </div>
      )}
      <FormField id="attribution-reason" label={t.reason} error={errors.reason}>
        <textarea
          id="attribution-reason"
          rows={2}
          maxLength={500}
          className={fieldClass(Boolean(errors.reason))}
          value={reason}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={describedBy('attribution-reason', false, Boolean(errors.reason))}
          onChange={(e) => setReason(e.target.value)}
          data-testid="attribution-reason"
        />
      </FormField>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirm}
          aria-invalid={errors.confirm ? true : undefined}
          aria-describedby={errors.confirm ? 'attribution-confirm-error' : undefined}
          onChange={(e) => setConfirm(e.target.checked)}
          data-testid="attribution-confirm"
        />
        <span>{t.confirm}</span>
      </label>
      {errors.confirm && (
        <p id="attribution-confirm-error" className="text-xs font-medium text-red-700">
          {errors.confirm}
        </p>
      )}
      {failure && <ErrorNote>{failure}</ErrorNote>}
      {saved && (
        <p role="status" className="text-sm text-emerald-700" data-testid="attribution-saved">
          {t.saved}
        </p>
      )}
      <div>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={busy}
          data-testid="attribution-save"
        >
          {first ? t.saveFirst : t.saveChange}
        </button>
      </div>
    </form>
  );
}
