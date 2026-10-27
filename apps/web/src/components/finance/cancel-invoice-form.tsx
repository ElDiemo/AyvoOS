'use client';

import { invoiceDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = financeCs.invoices;

/** Cancels a TEST invoice with a reason (a separate record; the invoice itself never changes). */
export function CancelInvoiceForm({ number }: { number: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const attempt = useAttempt();
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="cancel-invoice"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const r = await attempt.run(`${number}:${reason}`, (requestId) =>
          apiSend('POST', `admin/finance/invoices/${number}/cancel`, invoiceDetailSchema, {
            requestId,
            reason: reason.trim(),
          }),
        );
        if (r.ok) router.refresh();
        else if (r.error)
          setError(
            r.error instanceof ClientApiError && r.error.code && t.errors[r.error.code]
              ? t.errors[r.error.code]!
              : r.error instanceof Error
                ? r.error.message
                : String(r.error),
          );
      }}
    >
      <p className="text-xs text-stone-500">{t.cancelHelp}</p>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t.cancelReason}
        <input
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
          data-testid="cancel-invoice-reason"
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button
          type="submit"
          className={buttonClass.danger}
          disabled={attempt.busy}
          data-testid="cancel-invoice-submit"
        >
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
