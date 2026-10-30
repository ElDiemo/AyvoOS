'use client';

import { invoiceDeliveriesSchema, type InvoiceDeliveries, type InvoiceDelivery } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, inputClass, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = financeCs.invoices.delivery;
const message = (e: unknown) =>
  e instanceof ClientApiError && e.code && t.errors[e.code]
    ? t.errors[e.code]!
    : e instanceof Error
      ? e.message
      : String(e);

/** One attempt: its state in words (never "doručeno"), its code and history. */
function Attempt({ d }: { d: InvoiceDelivery }) {
  return (
    <li className="flex flex-col gap-1 py-2" data-testid={`delivery-${d.state}`}>
      <strong data-testid="delivery-state">{t.state[d.state]}</strong>
      <span className="break-all text-stone-600">
        {d.recipient} · {d.sender}
      </span>
      {d.code && <span className="text-stone-600">{t.codes[d.code] ?? d.code}</span>}
      {d.retryReason && (
        <span className="text-stone-600">
          {t.retryReasonShown}: {d.retryReason}
        </span>
      )}
      <span className="text-xs text-stone-500">
        {t.requested(formatDateTimeCs(d.requestedAt), d.requestedByName)}
      </span>
      <ul className="text-xs text-stone-500" data-testid="delivery-events">
        {d.events.map((e, i) => (
          <li key={i}>
            {formatDateTimeCs(e.occurredAt)} · {t.state[e.state]}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Sending by hand: the address is shown first; a retry needs a reason and the duplicate warning. */
export function InvoiceDeliveryPanel({
  number,
  data,
  canSend,
}: {
  number: string;
  data: InvoiceDeliveries;
  canSend: boolean;
}) {
  const router = useRouter();
  const attempt = useAttempt();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const latest = data.deliveries.at(-1);
  const live = latest?.state === 'QUEUED' || latest?.state === 'SENDING';

  // A sending goes on in the background: the page follows it while it is live.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [live, router]);

  async function submit(path: string, body: Record<string, unknown>, key: string) {
    setError(null);
    const r = await attempt.run(key, (requestId) =>
      apiSend('POST', path, invoiceDeliveriesSchema, {
        requestId,
        recipient: data.recipient,
        ...body,
      }),
    );
    if (r.ok) {
      setReason('');
      setUnderstood(false);
      router.refresh();
    } else if (r.error) setError(message(r.error));
  }
  const base = `admin/finance/invoices/${number}/deliveries`;
  const retryable = latest?.state === 'FAILED' || latest?.state === 'UNCERTAIN';

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="invoice-delivery">
      {data.blocker && <Notice tone="info">{t.blockers[data.blocker]}</Notice>}
      {latest?.state === 'UNCERTAIN' && <Notice tone="warning">{t.uncertainHelp}</Notice>}
      {latest?.state === 'SENT' && <p className="text-stone-600">{t.sentHelp}</p>}
      {data.deliveries.length === 0 ? (
        <p className="text-stone-500">{t.none}</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {data.deliveries.map((d) => (
            <Attempt key={d.id} d={d} />
          ))}
        </ul>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {canSend && data.sendable && !latest && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(base, {}, `send:${number}`);
          }}
        >
          <p data-testid="delivery-recipient" className="break-all">
            {t.willSend(data.recipient, data.sender)}
          </p>
          <div>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={attempt.busy}
              data-testid="delivery-send"
            >
              {t.send}
            </button>
          </div>
        </form>
      )}
      {canSend && data.sendable && retryable && (
        <form
          className="flex flex-col gap-2"
          data-testid="delivery-retry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              `${base}/${latest.id}/retry`,
              { reason: reason.trim(), acknowledgeDuplicateRisk: true },
              `retry:${latest.id}:${reason}`,
            );
          }}
        >
          <p className="break-all">{t.willSend(data.recipient, data.sender)}</p>
          <label className="flex flex-col gap-1 font-medium">
            {t.retryReason}
            <input
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={inputClass}
              data-testid="delivery-retry-reason"
            />
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              required
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="delivery-retry-understood"
            />
            <span>{t.duplicateWarning}</span>
          </label>
          <div>
            <button
              type="submit"
              className={buttonClass.secondary}
              disabled={attempt.busy}
              data-testid="delivery-retry"
            >
              {t.retry}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
