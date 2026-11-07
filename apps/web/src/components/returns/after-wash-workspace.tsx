'use client';

import {
  afterWashQueueSchema,
  afterWashScanResultSchema,
  type AfterWashBottle,
  type AfterWashQueue,
} from '@ayvo/types';
import { useRef, useState } from 'react';
import { Card, EmptyState, buttonClass, inputClass } from '@/components/ui';
import {
  ScanQueueStatus,
  useScanQueue,
  type QueueItem,
} from '@/components/workstations/use-scan-queue';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet, apiSend } from '@/lib/client-api';
import { errorText, isUncertain } from './stable-requests';

const t = returnsCs;
const w = returnsCs.afterWash;
type Message = { tone: 'ok' | 'error'; text: string } | null;

/**
 * Po mytí (doc 048 §2): one scan per washed and inspected bottle — RETURNED → "Připravená k
 * plnění · Po mytí" — and the queue: waiting, set aside (revoked design) and ready. The scan
 * field never blocks: each scan is queued at once with its own request id and sent in order
 * (useScanQueue), so a bottle scanned while an earlier answer is pending is never lost. An
 * uncertain answer stops the queue until "Zkusit znovu" sends the SAME request; a definite
 * refusal is shown and the next scan follows. The refresh of the queue is separate from the
 * writes ("Obnovit" only reads).
 */
export function AfterWashWorkspace({ initial }: { initial: AfterWashQueue }) {
  const [queue, setQueue] = useState(initial);
  const [message, setMessage] = useState<Message>(null);
  const [stale, setStale] = useState(false);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Only the latest read is shown (reads after successive scans may answer out of order).
  const reads = useRef(0);

  const refresh = async () => {
    const n = ++reads.current;
    try {
      const next = await apiGet('admin/returns/after-wash', afterWashQueueSchema);
      if (n !== reads.current) return;
      setQueue(next);
      setStale(false);
    } catch {
      if (n === reads.current) setStale(true);
    }
  };

  /** Sends one scan; false = no definite answer (the queue stops on it). */
  async function process(item: QueueItem): Promise<boolean> {
    try {
      const r = await apiSend('POST', 'admin/returns/after-wash', afterWashScanResultSchema, {
        requestId: item.requestId,
        scannedValue: item.raw,
      });
      setMessage({
        tone: 'ok',
        text: r.repeated
          ? w.repeated(r.bottleCode)
          : w.ready(r.bottleCode, r.product?.name ?? null, r.design),
      });
      void refresh();
      return true;
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err) });
      return !isUncertain(err);
    }
  }
  const scans = useScanQueue(process, undefined, 'ayvo:after-wash');
  const focusScan = () => input.current?.focus();

  return (
    <div className="flex flex-col gap-6" data-testid="after-wash">
      <Card title={w.scan}>
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            const scanned = value.trim();
            if (!scanned) return;
            // Queued with its own request id, the field free at once for the next bottle.
            scans.enqueue({ kind: 'scan', raw: scanned, revision: 0 });
            setValue('');
            focusScan();
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
          >
            {w.submit}
          </button>
        </form>
        <p className="mt-2 text-sm text-stone-600">{w.hint}</p>
        <div className="mt-3">
          <ScanQueueStatus
            queue={scans}
            testIdPrefix="after-wash-scans"
            focusScan={focusScan}
            texts={w.queue}
          />
        </div>
        {stale && (
          <div
            role="alert"
            data-testid="refresh-failed"
            className="mt-3 flex flex-col gap-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{w.refreshFailed}</span>
            <button type="button" className={buttonClass.secondary} onClick={refresh}>
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
