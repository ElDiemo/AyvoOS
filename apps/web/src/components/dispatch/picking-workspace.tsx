'use client';

import {
  orderDetailSchema,
  orderScanResultSchema,
  orderShipmentSchema,
  type DispatchPrinter,
  type OrderDetail,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog, uncertain, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, inputClass } from '@/components/ui';
import {
  ScanQueueStatus,
  useScanQueue,
  type QueueItem,
} from '@/components/workstations/use-scan-queue';
import { formatDateCs } from '@/i18n/cs/format';
import { ordersCs } from '@/i18n/cs/orders';
import { apiGet, apiSend } from '@/lib/client-api';
import { useScanFocusReturn } from '@/lib/scan-focus';
import { orderErrorText } from './order-errors';
import { OrderLines } from './order-lines';

const t = ordersCs.pick;
type Message = { tone: 'ok' | 'info' | 'error'; text: string } | null;
type LogEntry = {
  id: string;
  scanned: string;
  result: 'added' | 'already' | 'refused';
  text: string;
};

/**
 * Kompletace on a mobile terminal (doc 028): the hotel, order and site stay on top, large
 * counters per product, a scan field that never blocks. Every scan is queued with its own stable
 * request id and sent in order (the shared station queue): a scanner may send the next QR while
 * the previous one is still being saved. An uncertain answer stops the queue until "Zkusit znovu"
 * sends the SAME attempt; unresolved scans survive a reload of this tab, block leaving and the
 * site switch (before anything is sent) and block removing crates or completing.
 */
export function PickingWorkspace({
  initial,
  combined,
}: {
  initial: OrderDetail;
  /**
   * "Dokončit a vytisknout štítky" (doc 030 §1): offered when the user may also prepare the
   * shipment and the site has a carrier; `printer` = where the labels will be printed (null: none).
   */
  combined: { printer: DispatchPrinter | null } | null;
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [order, setOrder] = useState(initial);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const action = useAttempt();
  useScanFocusReturn(input);
  const focusScan = useCallback(() => input.current?.focus(), []);
  const open = order.status === 'OPEN';
  // After the removal dialog closes (the browser gives the focus back to its opener first), the
  // scan field takes it again: this effect runs after the dialog's own close effect.
  useEffect(() => {
    if (removing === null && open) input.current?.focus();
  }, [removing, open]);
  const complete = order.lines.every((l) => l.loadedCrates === l.requiredCrates);

  const record = (item: QueueItem, result: LogEntry['result'], text: string) =>
    setLog((l) => [{ id: item.requestId, scanned: item.raw, result, text }, ...l].slice(0, 8));

  async function process(item: QueueItem): Promise<boolean> {
    try {
      const res = await apiSend(
        'POST',
        `admin/orders/${order.code}/crates`,
        orderScanResultSchema,
        {
          requestId: item.requestId,
          scannedValue: item.raw,
        },
      );
      setOrder(res.order);
      const text =
        res.outcome === 'ADDED' ? t.added(res.crate, res.product.name) : t.already(res.crate);
      setMessage({ tone: res.outcome === 'ADDED' ? 'ok' : 'info', text });
      record(item, res.outcome === 'ADDED' ? 'added' : 'already', res.crate);
      return true;
    } catch (error) {
      if (uncertain(error)) {
        setMessage({ tone: 'error', text: t.uncertain });
        return false; // stays at the head of the queue with its request id
      }
      const text = orderErrorText(error);
      setMessage({ tone: 'error', text });
      record(item, 'refused', text);
      return true;
    }
  }
  const queue = useScanQueue(process, undefined, `ayvo:picking:${order.code}`);
  const settled = !queue.unresolved && !queue.busy;
  // Once the queue is resolved ("Zkusit znovu" disappears with its button), the scanner types
  // into the scan field again.
  const unresolved = queue.unresolved;
  useEffect(() => {
    if (!unresolved && open) input.current?.focus();
  }, [unresolved, open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const scanned = value.trim();
    setValue('');
    if (scanned) queue.enqueue({ kind: 'crate', raw: scanned, revision: 0 });
    input.current?.focus();
  }

  async function remove() {
    if (!removing || !settled) return;
    const body = { reason: reason.trim() || null };
    const result = await action.run(`${removing}:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `admin/orders/${order.code}/crates/${removing}/remove`, orderDetailSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setOrder(result.value);
      setMessage({ tone: 'info', text: `${ordersCs.detail.events.CRATE_REMOVED}: ${removing}` });
      setRemoving(null);
      setReason('');
    } else if (result.error) {
      setMessage({ tone: 'error', text: orderErrorText(result.error) });
      if (!uncertain(result.error)) setRemoving(null);
    }
  }

  const parcels = order.lines.reduce((n, l) => n + l.requiredCrates, 0);
  const printer = combined?.printer ?? null;

  async function finish() {
    if (!settled) return;
    if (combined) {
      // Completes, creates the labels once and prints them on the printer shown on the button.
      const result = await action.run(`complete-and-label:${order.code}`, (requestId) =>
        apiSend('POST', `admin/orders/${order.code}/complete-and-label`, orderShipmentSchema, {
          requestId,
          printerId: printer?.id ?? null,
        }),
      );
      if (result.ok) {
        setMessage({
          tone: 'ok',
          text: printer ? t.labelsQueued(printer.name) : t.labelsPrepared,
        });
      } else if (result.error) {
        // The picking may be complete although a later step failed: the order shows how to go on.
        setMessage({
          tone: 'error',
          text: uncertain(result.error) ? t.uncertain : orderErrorText(result.error),
        });
      }
      if (result.ok || (result.error && !uncertain(result.error))) {
        try {
          setOrder(await apiGet(`admin/orders/${order.code}`, orderDetailSchema));
        } catch {
          // shown on the next refresh
        }
        router.refresh();
      }
      return;
    }
    const result = await action.run(`complete:${order.code}`, (requestId) =>
      apiSend('POST', `admin/orders/${order.code}/complete`, orderDetailSchema, { requestId }),
    );
    if (result.ok) {
      setOrder(result.value);
      setMessage(null);
      router.refresh();
    } else if (result.error) setMessage({ tone: 'error', text: orderErrorText(result.error) });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="picking">
      <header
        className="sticky top-0 z-10 -mx-4 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border"
        data-testid="picking-context"
      >
        <p className="text-xs uppercase tracking-wide text-stone-500">
          {t.title} · {order.site.name} ({order.site.code})
        </p>
        <p className="text-lg font-semibold wrap-anywhere">{order.hotel.name}</p>
        <p className="text-sm text-stone-600">
          <span className="font-mono">{order.code}</span> · {formatDateCs(order.requestedShipDate)}{' '}
          ·{' '}
          <span className="tabular-nums" data-testid="picking-totals">
            {ordersCs.columns.crates} {order.totals.loadedCrates}/{order.totals.requiredCrates} ·{' '}
            {ordersCs.columns.bottles} {order.totals.loadedBottles}/{order.totals.requiredBottles}
          </span>
        </p>
      </header>

      {order.status === 'READY_TO_DISPATCH' && (
        <div
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950"
          data-testid="picking-ready"
        >
          <p className="text-xl font-bold">{t.ready}</p>
          <p className="mt-1 text-sm">{t.readyText}</p>
          {combined && (
            <Link
              href={`/dispatch/orders/${order.code}`}
              className={cn(buttonClass.primary, 'mt-3 inline-block')}
              data-testid="open-order"
            >
              {t.openOrder}
            </Link>
          )}
        </div>
      )}
      {order.status === 'CANCELLED' && (
        <p role="status" className="rounded-md bg-stone-100 p-3 text-sm">
          {t.notOpen}
        </p>
      )}

      {open && (
        <form onSubmit={submit} className="flex flex-col gap-2" data-testid="picking-scan">
          <label htmlFor={`${id}-scan`} className="text-sm font-medium">
            {t.scanLabel}
          </label>
          {/* Never disabled: a scanner may send the next code while one is being saved. */}
          <input
            ref={input}
            id={`${id}-scan`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t.scanPlaceholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            autoFocus
            aria-describedby={`${id}-scan-help`}
            className={cn(inputClass, 'py-3 text-lg')}
            data-testid="scan-input"
          />
          <p id={`${id}-scan-help`} className="text-xs text-stone-500">
            {queue.busy ? t.busy : t.scanHelp}
          </p>
        </form>
      )}

      <ScanQueueStatus
        queue={queue}
        testIdPrefix="picking"
        focusScan={focusScan}
        texts={{
          leaveGuard: t.leaveGuard,
          blockedTitle: t.blockedTitle,
          blockedText: t.blockedText,
          waiting: t.waiting,
          retry: t.retry,
        }}
      />

      {message && (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          data-testid="pick-message"
          data-tone={message.tone}
          className={cn(
            'rounded-lg border p-3 text-base font-medium',
            message.tone === 'ok' && 'border-emerald-300 bg-emerald-50 text-emerald-950',
            message.tone === 'info' && 'border-stone-300 bg-stone-50 text-stone-800',
            message.tone === 'error' && 'border-red-300 bg-red-50 text-red-950',
          )}
        >
          {message.text}
        </div>
      )}

      <OrderLines order={order} large />

      {open && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className={cn(buttonClass.primary, 'py-3 text-base')}
            disabled={!complete || !settled || action.busy}
            onClick={() => void finish()}
            data-testid="complete-picking"
          >
            {!combined ? t.complete : printer ? t.completeAndPrint(parcels) : t.completeAndLabel}
          </button>
          {combined && printer && (
            <p className="text-xs text-stone-600" data-testid="print-target">
              {t.printTarget(`${printer.name} (${printer.model})`)}
            </p>
          )}
          {combined && !printer && <p className="text-xs text-stone-500">{t.noAutoPrint}</p>}
          {!complete && <p className="text-xs text-stone-500">{t.completeHelp}</p>}
          {complete && !settled && <p className="text-xs text-stone-500">{t.waitForScans}</p>}
        </div>
      )}

      {log.length > 0 && (
        <section aria-labelledby={`${id}-log`}>
          <h2 id={`${id}-log`} className="mb-2 text-sm font-semibold">
            {t.log}
          </h2>
          <ol className="flex flex-col gap-1 text-sm" data-testid="scan-log">
            {log.map((e) => (
              <li
                key={e.id}
                data-result={e.result}
                className={cn(
                  'rounded border px-2 py-1 wrap-anywhere',
                  e.result === 'refused' ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-white',
                )}
              >
                <span className="font-medium">
                  {e.result === 'added'
                    ? t.logAdded
                    : e.result === 'already'
                      ? t.logAlready
                      : t.logRefused}
                </span>{' '}
                · {e.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      {order.crates.length > 0 && (
        <section aria-labelledby={`${id}-crates`}>
          <h2 id={`${id}-crates`} className="mb-2 text-sm font-semibold">
            {ordersCs.detail.crates}
          </h2>
          <ul className="flex flex-col gap-2" data-testid="picked-crates">
            {order.crates.map((c) => (
              <li
                key={c.crate}
                className="flex items-center justify-between gap-3 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
                data-testid={`picked-${c.crate}`}
              >
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-mono font-medium">{c.crate}</span> · {c.product.name} ·{' '}
                  {c.bottles} ks
                </span>
                {open && (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    disabled={!settled}
                    onClick={() => setRemoving(c.crate)}
                  >
                    {t.remove}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href={`/dispatch/orders/${order.code}`} className="text-sm text-stone-600 underline">
        {t.back}
      </Link>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? t.removeTitle(removing) : ''}
        confirmLabel={t.remove}
        danger
        busy={action.busy}
        onConfirm={() => void remove()}
        onCancel={() => {
          setRemoving(null);
          setReason('');
        }}
        testId="remove-crate"
      >
        <p>{t.removeText}</p>
        <label
          htmlFor={`${id}-reason`}
          className="text-xs font-medium uppercase tracking-wide text-stone-500"
        >
          {t.removeReason}
        </label>
        <input
          id={`${id}-reason`}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
      </ConfirmDialog>
    </div>
  );
}
