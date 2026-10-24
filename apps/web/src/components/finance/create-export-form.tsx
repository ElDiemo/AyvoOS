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
import { apiGet, apiSend } from '@/lib/client-api';
import { ExportLines } from './export-lines';

const t = financeCs.exports;

/** Choose a period and mode, see what it would contain, then create the export. */
export function CreateExportForm({
  defaultFrom,
  defaultTo,
}: {
  defaultFrom: string;
  defaultTo: string;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
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

  async function showPreview(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ periodFrom: from, periodTo: to, mode });
      setPreview(
        await apiGet(
          `admin/finance/exports/preview?${q.toString()}`,
          accountingExportPreviewSchema,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const done = await apiSend('POST', 'admin/finance/exports', accountingExportDetailSchema, {
        requestId: requestId.current,
        periodFrom: from,
        periodTo: to,
        mode,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      requestId.current = crypto.randomUUID();
      router.push(`/finance/exports/${done.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
  return (
    <form onSubmit={showPreview} className="flex flex-col gap-4" data-testid="create-export">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className={label}>
          {t.from}
          <input
            required
            type="date"
            className={inputClass}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              changed();
            }}
          />
        </label>
        <label className={label}>
          {t.to}
          <input
            required
            type="date"
            className={inputClass}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
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
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy} className={buttonClass.secondary}>
          {t.preview}
        </button>
      </div>
      {preview && (
        <div className="flex flex-col gap-3" data-testid="export-preview">
          {preview.lines.length === 0 ? (
            <Notice tone="info">{t.previewEmpty}</Notice>
          ) : (
            <>
              <p className="text-sm font-medium">{t.count(preview.lines.length)}</p>
              <ExportLines lines={preview.lines} />
              {preview.tooLarge ? (
                <ErrorNote>
                  {t.previewTooLarge(preview.limits.documents, preview.limits.bytes / 1024 / 1024)}
                </ErrorNote>
              ) : (
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
              )}
            </>
          )}
        </div>
      )}
    </form>
  );
}
