'use client';

import type { BillingPendingTransfer } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { buttonClass, ErrorNote } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { formatDateCs } from '@/i18n/cs/format';
import { apiSend } from '@/lib/client-api';

/**
 * A change of payer reserved and not settled (v6, #148): the leaving payer's portal operations
 * are being fenced. "Dokončit" finishes it with the reserved terms (the same fence); "Zrušit"
 * writes no terms — a fence already written stays and is restored only on the payer page.
 */
export function PendingTransfer({
  code,
  transfer,
  payerName,
}: {
  code: string;
  transfer: BillingPendingTransfer;
  payerName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: 'finish' | 'abandon') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend(
        'POST',
        `admin/finance/billing/agreements/${code}/transfers/${transfer.termsRevision}/${action}`,
        z.unknown(),
        {},
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="agreement-pending-transfer">
      <p>{t.pendingTransfer.help(payerName, formatDateCs(transfer.fenceEndsOn))}</p>
      <p className="text-xs text-stone-500">{transfer.reason}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.primary}
          disabled={busy}
          onClick={() => void run('finish')}
          data-testid="agreement-transfer-finish"
        >
          {t.pendingTransfer.finish}
        </button>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={busy}
          onClick={() => void run('abandon')}
          data-testid="agreement-transfer-abandon"
        >
          {t.pendingTransfer.abandon}
        </button>
      </div>
      <p className="text-xs text-stone-500">{t.pendingTransfer.abandonNote}</p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
