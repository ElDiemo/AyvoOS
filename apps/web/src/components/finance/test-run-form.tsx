'use client';

import { testRunPreviewSchema, testRunResultSchema, type TestRunPreview } from '@ayvo/types';
import Link from 'next/link';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, Notice, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { billingCs } from '@/i18n/cs/finance-billing';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { financeAmount, sumAmounts } from './finance-format';

const t = financeCs.invoices.run;
const errors = financeCs.invoices.errors;

const errorText = (e: unknown) =>
  e instanceof ClientApiError && e.code && errors[e.code]
    ? errors[e.code]!
    : e instanceof Error
      ? e.message
      : String(e);

type Item = TestRunPreview['items'][number];

/**
 * The monthly run of TEST invoices (doc 040 §11): the user states the period, sees every agreement
 * of it with what an invoice would say or why it cannot be made, states the issue date and chooses
 * the agreements. Neither date is filled in or derived; the action stays disabled without them.
 * One separate invoice per agreement; nothing is sent anywhere.
 */
export function TestRunForm() {
  const [month, setMonth] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [preview, setPreview] = useState<TestRunPreview | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ agreementCode: string; number: string }[] | null>(null);
  const attempt = useAttempt();

  async function load(e?: React.FormEvent, keepResult = false) {
    e?.preventDefault();
    setLoading(true);
    setChosen([]);
    if (!keepResult) {
      setError(null);
      setDone(null);
    }
    try {
      setPreview(
        await apiGet(
          `admin/finance/invoices/test-run/preview?month=${month}`,
          testRunPreviewSchema,
        ),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  const items = preview?.items ?? [];
  const ready = items.filter((i) => i.state === 'READY');
  const selected = ready.filter((i) => chosen.includes(i.agreementCode));
  const currencies = [...new Set(selected.map((i) => i.currency!))];
  const canRun = !!preview?.issuable && selected.length > 0 && !!issuedOn && !attempt.busy;

  async function run() {
    setError(null);
    // Exactly what the user sees: if the terms change before issuing, nothing is issued.
    const body = {
      month: preview!.month,
      issuedOn,
      lines: selected.map((i) => ({
        agreementCode: i.agreementCode,
        agreementRevision: i.agreementRevision!,
        customerVersion: i.customer!.version,
        priceListVersionId: i.price.priceListVersionId,
        unitPrice: i.price.perRoomMonth!,
        billedRooms: i.billedRooms!,
      })),
    };
    const r = await attempt.run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/finance/invoices/test-run', testRunResultSchema, {
        requestId,
        ...body,
      }),
    );
    if (r.ok) {
      setDone(r.value.invoices);
      await load(undefined, true);
    } else if (r.error) {
      setError(errorText(r.error));
      // Changed meanwhile: show the current state; the user decides again (nothing was issued).
      if (
        r.error instanceof ClientApiError &&
        (r.error.code === 'TERMS_CHANGED' || r.error.code === 'ALREADY_INVOICED')
      )
        await load(undefined, true);
    }
  }

  const describe = (i: Item) =>
    i.billedRooms !== null && i.price.perRoomMonth !== null && i.amount !== null
      ? t.line(
          i.billedRooms,
          financeAmount(i.price.perRoomMonth, i.currency),
          t.priceSource[i.price.source]!,
          financeAmount(i.amount, i.currency),
        )
      : t.noAmount;

  return (
    <div className="flex flex-col gap-4" data-testid="test-run-form">
      <form className="flex flex-wrap items-end gap-3" onSubmit={load}>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t.month}
          <input
            type="month"
            required
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setPreview(null);
              setChosen([]);
              setDone(null);
            }}
            className={inputClass}
            data-testid="run-month"
          />
        </label>
        <button
          type="submit"
          className={buttonClass.secondary}
          disabled={loading || !month}
          data-testid="run-load"
        >
          {t.load}
        </button>
      </form>

      {done && (
        <div role="status" className="text-sm" data-testid="run-done">
          <p className="font-medium">{t.done(done.length)}</p>
          <ul className="mt-1 flex flex-wrap gap-x-3">
            {done.map((d) => (
              <li key={d.number}>
                <Link href={`/finance/invoices/${d.number}`} className="font-mono underline">
                  {d.number}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && !preview.issuable && <Notice>{t.notIssuable}</Notice>}
      {preview && items.length === 0 && (
        <p className="text-sm text-stone-600" data-testid="run-empty">
          {t.empty}{' '}
          <Link href="/finance/billing" className="underline">
            {financeCs.invoices.toAgreements}
          </Link>
        </p>
      )}

      {items.length > 0 && (
        <>
          {ready.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setChosen(ready.map((i) => i.agreementCode))}
                data-testid="run-choose-ready"
              >
                {t.chooseReady(ready.length)}
              </button>
            </div>
          )}
          <ul className="divide-y divide-stone-100 text-sm" data-testid="run-items">
            {items.map((i) => (
              <li
                key={i.agreementCode}
                data-testid={`run-item-${i.agreementCode}`}
                data-state={i.state}
              >
                <label className="flex items-start gap-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={i.state !== 'READY'}
                    checked={chosen.includes(i.agreementCode)}
                    onChange={() =>
                      setChosen((c) =>
                        c.includes(i.agreementCode)
                          ? c.filter((x) => x !== i.agreementCode)
                          : [...c, i.agreementCode],
                      )
                    }
                    data-testid={`run-choose-${i.agreementCode}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{i.hotel.name}</span>{' '}
                    <span className="font-mono text-xs text-stone-500">{i.agreementCode}</span>
                    <span className="block text-stone-600">
                      {i.customer?.legalName ?? '—'}
                      {i.billingTiming && i.paymentTermsDays !== null
                        ? ` · ${billingCs.timing[i.billingTiming]} · ${t.termsDays(i.paymentTermsDays)}`
                        : ''}
                    </span>
                    {(i.state === 'READY' || i.state === 'ALREADY_INVOICED') && (
                      <span className="block tabular-nums text-stone-600">{describe(i)}</span>
                    )}
                    <span
                      className={
                        i.state === 'BLOCKED'
                          ? 'block text-amber-800'
                          : 'block text-xs text-stone-500'
                      }
                    >
                      {i.state === 'BLOCKED'
                        ? `${t.state.BLOCKED}: ${i.blockers.map((b) => t.blockers[b] ?? b).join(', ')}`
                        : i.state === 'ALREADY_INVOICED'
                          ? `${t.state.ALREADY_INVOICED}: ${i.invoiceNumber}`
                          : t.state[i.state]}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end gap-3 border-t border-stone-200 pt-4">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t.issuedOn}
              <input
                type="date"
                required
                value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)}
                className={inputClass}
                data-testid="run-issued-on"
              />
            </label>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!canRun}
              onClick={run}
              data-testid="run-submit"
            >
              {attempt.busy ? t.running : t.submit(selected.length)}
            </button>
            {currencies.map((c) => (
              <span key={c} className="text-sm tabular-nums" data-testid={`run-total-${c}`}>
                {t.total(
                  financeAmount(
                    sumAmounts(selected.filter((i) => i.currency === c).map((i) => i.amount!)),
                    c,
                  ),
                )}
              </span>
            ))}
          </div>
          {!issuedOn && selected.length > 0 && (
            <p className="text-sm text-amber-800" data-testid="run-need-date">
              {t.needDate}
            </p>
          )}
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
