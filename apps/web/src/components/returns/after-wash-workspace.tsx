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
import { ClientApiError, apiGet, apiSend } from '@/lib/client-api';
import { errorText, isUncertain } from './stable-requests';

const t = returnsCs;
const w = returnsCs.afterWash;
type Message = { tone: 'ok' | 'error'; text: string } | null;
/** A refused scan of this series: which bottle (or the scanned code) and why. */
type Refusal = { key: string; who: string; text: string };
const REFUSALS_SHOWN = 50;

/** The session ended (expired, signed out or deactivated): the client is leaving the page. */
const sessionEnded = (err: unknown) =>
  err instanceof ClientApiError &&
  (err.status === 401 || (err.status === 403 && err.code === 'ACCOUNT_INACTIVE'));

/** The refused bottle as the API names it, else the scanned code itself. */
function refusedWho(err: unknown, raw: string): string {
  const details = err instanceof ClientApiError ? err.details : null;
  const bottle =
    details && typeof details === 'object' && 'bottle' in details ? details.bottle : null;
  return typeof bottle === 'string' ? bottle : raw;
}

/**
 * Po mytí (doc 048 §2): one scan per washed and inspected bottle — RETURNED → "Připravená k
 * plnění · Po mytí" — and the queue: waiting, set aside (revoked design) and ready. The scan
 * field never blocks: each scan is queued at once with its own request id and sent in order
 * (useScanQueue), so a bottle scanned while an earlier answer is pending is never lost. An
 * uncertain answer stops the queue until "Zkusit znovu" sends the SAME request; so does the end
 * of the session: the client signs in again, and the unsent scans (with their request ids) are
 * kept in this tab under the user and the site (`storageKey`) — restored, stopped, only for the
 * same user at the same site. A definite refusal stays listed with its bottle and reason while
 * the next scans follow. Reads of the queue are merged: at most one runs, and one more follows
 * when answers arrived meanwhile; "Obnovit" only reads.
 */
export function AfterWashWorkspace({
  initial,
  storageKey,
}: {
  initial: AfterWashQueue;
  /** The tab's stored unsent scans: per user and active site. */
  storageKey: string;
}) {
  const [queue, setQueue] = useState(initial);
  const [message, setMessage] = useState<Message>(null);
  const [stale, setStale] = useState(false);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  // One read at a time; answers that arrive meanwhile ask for exactly one more read after it.
  const reading = useRef(false);
  const again = useRef(false);

  const refresh = async () => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        again.current = false;
        try {
          setQueue(await apiGet('admin/returns/after-wash', afterWashQueueSchema));
          setStale(false);
        } catch {
          setStale(true);
        }
      } while (again.current);
    } finally {
      reading.current = false;
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
      if (sessionEnded(err)) {
        // Not a result: stop and keep this and every later scan for the return (same user, site).
        setMessage({ tone: 'error', text: w.sessionEnded });
        return false;
      }
      setMessage({ tone: 'error', text: errorText(err) });
      if (isUncertain(err)) return false;
      const who = refusedWho(err, item.raw);
      setRefusals((list) =>
        [{ key: item.requestId, who, text: errorText(err) }, ...list].slice(0, REFUSALS_SHOWN),
      );
      return true;
    }
  }
  const scans = useScanQueue(process, undefined, storageKey);
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
        {refusals.length > 0 && (
          <div
            className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-950"
            data-testid="after-wash-refusals"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{w.refusals(refusals.length)}</p>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setRefusals([])}
              >
                {w.refusalsHide}
              </button>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {refusals.map((r) => (
                <li key={r.key} className="wrap-anywhere">
                  <span className="font-medium">{r.who}</span>: {r.text}
                </li>
              ))}
            </ul>
          </div>
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
