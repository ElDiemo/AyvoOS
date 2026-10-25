'use client';

import {
  accountingExportDetailSchema,
  accountingExportPreviewSchema,
  ACCOUNTING_EXPORT_MODES,
  type AccountingExportPreview,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote, inputClass, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { ExportLines } from './export-lines';
import { financeAmount } from './finance-format';

const t = financeCs.exports;

/**
 * Choose the handover month and the mode, see exactly what the export would contain, then
 * confirm THAT preview (its fingerprint): if anything changed meanwhile the API answers
 * PREVIEW_STALE and a new preview is needed (review F-R2).
 */
export function CreateExportForm({
  lastMonth,
  thisMonth,
}: {
  lastMonth: string;
  thisMonth: string;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(lastMonth);
  const [mode, setMode] = useState<(typeof ACCOUNTING_EXPORT_MODES)[number]>('FULL');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<AccountingExportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const changed = () => {
    setPreview(null);
    requestId.current = crypto.randomUUID();
  };

  async function showPreview(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ handoverMonth: month, mode });
      setPreview(
        await apiGet(
          `admin/finance/exports/preview?${q.toString()}`,
          accountingExportPreviewSchema,
        ),
      );
      requestId.current = crypto.randomUUID();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const done = await apiSend('POST', 'admin/finance/exports', accountingExportDetailSchema, {
        requestId: requestId.current,
        handoverMonth: month,
        mode,
        previewFingerprint: preview.fingerprint,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      requestId.current = crypto.randomUUID();
      router.push(`/finance/exports/${done.code}`);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === 'PREVIEW_STALE') {
        setPreview(null);
        setError(t.stale);
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
  const blocked = !!preview && (preview.tooLarge || preview.incomplete.length > 0);
  return (
    <form onSubmit={showPreview} className="flex flex-col gap-4" data-testid="create-export">
      <div className="flex flex-wrap gap-2">
        {[
          [t.lastMonth, lastMonth],
          [t.thisMonth, thisMonth],
        ].map(([text, value]) => (
          <button
            key={value}
            type="button"
            className={month === value ? buttonClass.primary : buttonClass.secondary}
            onClick={() => {
              setMonth(value!);
              changed();
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={label}>
          {t.month}
          <input
            required
            type="month"
            className={inputClass}
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              changed();
            }}
          />
        </label>
        <label className={label}>
          {t.mode}
          <select
            className={inputClass}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              changed();
            }}
          >
            {ACCOUNTING_EXPORT_MODES.map((m) => (
              <option key={m} value={m}>
                {t.modes[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={label}>
        {t.note}
        <input
          maxLength={500}
          className={inputClass}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            requestId.current = crypto.randomUUID();
          }}
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy || !month} className={buttonClass.secondary}>
          {t.preview}
        </button>
      </div>
      {preview && (
        <div className="flex flex-col gap-3" data-testid="export-preview">
          {preview.incomplete.length > 0 && (
            <ErrorNote>
              {t.incomplete} {preview.incomplete.map((i) => i.code).join(', ')}
            </ErrorNote>
          )}
          {preview.unassigned > 0 && <Notice>{t.unassigned(preview.unassigned)}</Notice>}
          {preview.lines.length === 0 ? (
            <Notice tone="info">{t.previewEmpty}</Notice>
          ) : (
            <>
              <p className="text-sm font-medium">{t.count(preview.lines.length)}</p>
              <ExportLines lines={preview.lines} />
              {preview.totals.length > 0 && (
                <p className="text-sm">
                  {t.totals}:{' '}
                  {preview.totals.map((x) => financeAmount(x.amount, x.currency)).join(' · ')}
                </p>
              )}
              {preview.tooLarge && (
                <ErrorNote>
                  {t.previewTooLarge(preview.limits.documents, preview.limits.bytes / 1024 / 1024)}
                </ErrorNote>
              )}
              {!blocked && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-stone-500">{t.confirmHelp}</p>
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      className={buttonClass.primary}
                      onClick={() => void create()}
                    >
                      {busy ? t.busy : t.confirm}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </form>
  );
}
