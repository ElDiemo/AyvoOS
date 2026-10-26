'use client';

import { bankSyncResultSchema, type BankSyncRun } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiSend } from '@/lib/client-api';

const t = financeCs.bank;

/**
 * Reads new transactions of every configured account now (finance:bank_sync). Each account ends
 * as its own run; a failed one is said plainly with its reason — a bank outage is never hidden.
 */
export function BankSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<BankSyncRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setRuns(null);
    try {
      const res = await apiSend('POST', 'admin/finance/bank/sync', bankSyncResultSchema, {});
      setRuns(res.runs);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className={buttonClass.primary}
          data-testid="bank-sync"
        >
          {busy ? t.syncing : t.sync}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {runs?.map((r) =>
        r.status === 'FAILED' ? (
          <ErrorNote key={r.id}>
            {r.accountNumber}/{r.currency}: {r.errorCode ? t.errors[r.errorCode] : ''}
          </ErrorNote>
        ) : (
          <Notice key={r.id} tone="info">
            {r.accountNumber}/{r.currency}: {t.syncDone}{' '}
            {t.runSummary(r.pages ?? 0, r.received ?? 0, r.newCount ?? 0, r.changedCount ?? 0)}
          </Notice>
        ),
      )}
    </div>
  );
}
