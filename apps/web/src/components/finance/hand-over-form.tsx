'use client';

import { accountingExportDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiSend } from '@/lib/client-api';

const t = financeCs.exports.handOver;

/** "Předáno účetní": recorded by hand, once (a download never counts as a handover). */
export function HandOverForm({ code, today }: { code: string; today: string }) {
  const router = useRouter();
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend(
        'POST',
        `admin/finance/exports/${code}/handover`,
        accountingExportDetailSchema,
        {
          requestId: requestId.current,
          handedOverOn: day,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="export-handover">
      <p className="text-sm text-stone-600">{t.help}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={label}>
          {t.date}
          <input
            required
            type="date"
            className={inputClass}
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              requestId.current = crypto.randomUUID();
            }}
          />
        </label>
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
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy || !day} className={buttonClass.primary}>
          {busy ? t.busy : t.submit}
        </button>
      </div>
    </form>
  );
}
