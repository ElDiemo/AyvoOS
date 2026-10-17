'use client';

import { orderDetailSchema, orderScanResultSchema, type OrderDetail } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog, uncertain, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, inputClass } from '@/components/ui';
import { formatDateCs } from '@/i18n/cs/format';
import { ordersCs } from '@/i18n/cs/orders';
import { apiSend } from '@/lib/client-api';
import { useScanFocusReturn } from '@/lib/scan-focus';
import { orderErrorText } from './order-errors';
import { OrderLines } from './order-lines';

const t = ordersCs.pick;
type Message = { tone: 'ok' | 'info' | 'error'; text: string } | null;

/**
 * Kompletace on a mobile terminal (doc 028): the hotel and order stay on top, large counters per
 * product, a focused scan field. One scan = one request id; after an uncertain answer the same
 * scan is retried with the same id (nothing is doubled). Any authorized worker may continue.
 */
export function PickingWorkspace({ initial }: { initial: OrderDetail }) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [order, setOrder] = useState(initial);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const [retry, setRetry] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const scan = useAttempt();
  const action = useAttempt();
  useScanFocusReturn(input);
  const open = order.status === 'OPEN';
  const complete = order.lines.every((l) => l.loadedCrates === l.requiredCrates);

  // The field is disabled while a scan is saved: focus returns once it is enabled again, after
  // every answer (accepted or refused), so the next scan never types into nowhere.
  useEffect(() => {
    if (open && !removing && !scan.busy && retry === null) input.current?.focus();
  }, [open, removing, scan.busy, retry, order, message]);

  async function send(scanned: string) {
    const result = await scan.run(scanned, (requestId) =>
      apiSend('POST', `admin/orders/${order.code}/crates`, orderScanResultSchema, {
        requestId,
        scannedValue: scanned,
      }),
    );
    if (result.ok) {
      setOrder(result.value.order);
      setRetry(null);
      setValue('');
      setMessage(
        result.value.outcome === 'ADDED'
          ? { tone: 'ok', text: t.added(result.value.crate, result.value.product.name) }
          : { tone: 'info', text: t.already(result.value.crate) },
      );
    } else if (result.error) {
      if (uncertain(result.error)) {
        setRetry(scanned);
        setMessage({ tone: 'error', text: t.uncertain });
      } else {
        setRetry(null);
        setValue('');
        setMessage({ tone: 'error', text: orderErrorText(result.error) });
      }
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const scanned = value.trim();
    if (!scanned || scan.busy) return;
    void send(scanned);
  }

  async function remove() {
    if (!removing) return;
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
      setRemoving(null);
    }
  }

  async function finish() {
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
        <p className="text-xs uppercase tracking-wide text-stone-500">{t.title}</p>
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
          <div className="flex gap-2">
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
              disabled={scan.busy || retry !== null}
              aria-describedby={`${id}-scan-help`}
              className={cn(inputClass, 'py-3 text-lg')}
              data-testid="scan-input"
            />
          </div>
          <p id={`${id}-scan-help`} className="text-xs text-stone-500">
            {scan.busy ? t.busy : t.scanHelp}
          </p>
        </form>
      )}

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
          {retry && (
            <div className="mt-2">
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => void send(retry)}
                disabled={scan.busy}
              >
                {t.retry}
              </button>
            </div>
          )}
        </div>
      )}

      <OrderLines order={order} large />

      {open && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className={cn(buttonClass.primary, 'py-3 text-base')}
            disabled={!complete || action.busy}
            onClick={() => void finish()}
            data-testid="complete-picking"
          >
            {t.complete}
          </button>
          {!complete && <p className="text-xs text-stone-500">{t.completeHelp}</p>}
        </div>
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
