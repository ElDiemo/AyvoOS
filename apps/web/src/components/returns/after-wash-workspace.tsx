'use client';

import {
  afterWashQueueSchema,
  afterWashScanResultSchema,
  type AfterWashBottle,
  type AfterWashQueue,
} from '@ayvo/types';
import { useRef, useState } from 'react';
import { Card, EmptyState, buttonClass, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet, apiSend } from '@/lib/client-api';
import { errorText, useStableRequests } from './stable-requests';

const t = returnsCs;
const w = returnsCs.afterWash;
type Message = { tone: 'ok' | 'error'; text: string } | null;

/**
 * Po mytí (doc 048 §2): one scan per washed and inspected bottle — RETURNED → "Připravená k
 * plnění · Po mytí" — and the queue: waiting, set aside (revoked design) and ready. Each scan is
 * one request with a stable id (a repeated attempt is the same request); the refresh of the queue
 * is separate from the write ("Obnovit" never sends the scan again).
 */
export function AfterWashWorkspace({ initial }: { initial: AfterWashQueue }) {
  const [queue, setQueue] = useState(initial);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const send = useStableRequests();

  const refresh = async () => {
    try {
      setQueue(await apiGet('admin/returns/after-wash', afterWashQueueSchema));
      setStale(false);
    } catch {
      setStale(true);
    }
  };
  const locked = busy || stale;

  return (
    <div className="flex flex-col gap-6" data-testid="after-wash">
      <Card title={w.scan}>
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const scanned = value.trim();
            if (!scanned) return;
            setBusy(true);
            try {
              try {
                const r = await send(`after-wash:${scanned}`, (requestId) =>
                  apiSend('POST', 'admin/returns/after-wash', afterWashScanResultSchema, {
                    requestId,
                    scannedValue: scanned,
                  }),
                );
                setMessage({
                  tone: 'ok',
                  text: r.repeated
                    ? w.repeated(r.bottleCode)
                    : w.ready(r.bottleCode, r.product?.name ?? null, r.design),
                });
                setValue('');
              } catch (err) {
                setMessage({ tone: 'error', text: errorText(err) });
                return;
              }
              await refresh();
            } finally {
              setBusy(false);
              input.current?.focus();
            }
          }}
        >
          <input
            ref={input}
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={w.scanPlaceholder}
            aria-label={w.scan}
            autoComplete="off"
            autoFocus
            name="bottle"
          />
          <button
            type="submit"
            className={`${buttonClass.primary} sm:shrink-0 sm:whitespace-nowrap`}
            disabled={locked}
          >
            {w.submit}
          </button>
        </form>
        <p className="mt-2 text-sm text-stone-600">{w.hint}</p>
        {stale && (
          <div
            role="alert"
            data-testid="refresh-failed"
            className="mt-3 flex flex-col gap-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{t.refreshFailed}</span>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={refresh}
            >
              {t.refresh}
            </button>
          </div>
        )}
        {message && (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            data-testid="after-wash-message"
            className={`mt-3 text-sm wrap-anywhere ${message.tone === 'error' ? 'text-red-700' : 'text-emerald-800'}`}
          >
            {message.text}
          </p>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <BottleList
          testId="after-wash-waiting"
          title={w.waiting}
          rows={queue.waiting}
          total={queue.counts.waiting}
          empty={w.waitingEmpty}
        />
        <BottleList
          testId="after-wash-withdrawn"
          title={w.withdrawn}
          hint={w.withdrawnHint}
          rows={queue.withdrawn}
          total={queue.counts.withdrawn}
          empty={w.withdrawnEmpty}
        />
        <BottleList
          testId="after-wash-ready"
          title={w.readyList}
          hint={w.readyHint}
          rows={queue.ready}
          total={queue.counts.ready}
          empty={w.readyEmpty}
        />
      </div>
    </div>
  );
}

function BottleList({
  testId,
  title,
  hint,
  rows,
  total,
  empty,
}: {
  testId: string;
  title: string;
  hint?: string;
  rows: AfterWashBottle[];
  total: number;
  empty: string;
}) {
  return (
    <Card title={`${title} (${w.count(rows.length, total)})`}>
      {hint && <p className="mb-3 text-sm text-stone-600">{hint}</p>}
      {rows.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100 text-sm" data-testid={testId}>
          {rows.map((b) => (
            <li key={b.bottleCode} className="flex flex-col gap-0.5 py-1.5">
              <span className="font-medium">{b.bottleCode}</span>
              <span className="text-stone-600 wrap-anywhere">
                {b.product ? b.product.name : w.noProduct}
                {b.design ? ` · ${b.design}` : ''}
              </span>
              <span className="text-xs text-stone-500">
                {w.since} {formatDateTimeCs(b.since)}
                {b.receipt ? ` · ${b.receipt}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
