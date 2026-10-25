'use client';

import { financeDocumentDetailSchema, type TakeOverCandidate } from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, EmptyState, ErrorNote, inputClass } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiSend } from '@/lib/client-api';
import { financeDate } from './finance-format';

/**
 * Supplier documents of Sklad (only the user's sites) that can become finance documents without
 * a second copy of the file. One request id per document and attempt (a retry is idempotent).
 */
export function TakeOverList({ candidates }: { candidates: readonly TakeOverCandidate[] }) {
  const router = useRouter();
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const requestId = (id: string) => {
    if (!requestIds.current.has(id)) requestIds.current.set(id, crypto.randomUUID());
    return requestIds.current.get(id)!;
  };

  async function takeOver(id: string) {
    setBusy(id);
    setError(null);
    try {
      const doc = await apiSend(
        'POST',
        'admin/finance/documents/take-over',
        financeDocumentDetailSchema,
        { requestId: requestId(id), supplierDocumentId: id, handoverMonth: month || null },
      );
      requestIds.current.delete(id);
      router.push(`/finance/documents/${doc.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const open = candidates.filter((c) => !c.takenOverBy);
  return (
    <div className="flex flex-col gap-3" data-testid="take-over-list">
      <p className="text-sm text-stone-600">{t.takeOver.help}</p>
      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t.fields.handoverMonth}
        <input
          type="month"
          className={inputClass}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {candidates.length === 0 ? (
        <EmptyState>{t.takeOver.empty}</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100">
          {candidates.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 text-sm">
                <span className="font-medium">{c.supplier.name}</span> · {c.documentNumber} ·{' '}
                {financeDate(c.issuedOn)} · {c.siteCode}
                {c.superseded && (
                  <span className="ml-1 text-xs text-stone-500">({t.takeOver.superseded})</span>
                )}
              </span>
              {c.takenOverBy ? (
                <Link href={`/finance/documents/${c.takenOverBy}`} className="text-sm underline">
                  {t.takeOver.taken(c.takenOverBy)}
                </Link>
              ) : (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy !== null}
                  onClick={() => takeOver(c.id)}
                >
                  {busy === c.id ? t.takeOver.busy : t.takeOver.submit}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && open.length === 0 && (
        <p className="text-xs text-stone-500">{t.takeOver.allTaken}</p>
      )}
    </div>
  );
}
