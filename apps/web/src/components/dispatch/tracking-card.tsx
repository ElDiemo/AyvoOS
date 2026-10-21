'use client';

import type { OrderShipment, ShipmentParcel, TrackingEvent } from '@ayvo/types';
import { useState } from 'react';
import { uncertain, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { shipmentsCs } from '@/i18n/cs/shipments';
import { orderErrorText } from './order-errors';

const t = shipmentsCs.tracking;
type Send = (path: string, body: object) => Promise<OrderShipment>;

/**
 * Přeprava u dopravce (doc 031): how many parcels the carrier has and has delivered, when it was
 * last checked (an outage keeps the last known state and says so), "Obnovit tracking", each
 * parcel's progress and its carrier history, collapsed. Problems are warnings, not states.
 */
export function TrackingCard({
  data,
  canRefresh,
  send,
  onDone,
  timeZone,
}: {
  data: OrderShipment;
  canRefresh: boolean;
  send: Send;
  onDone: () => void;
  timeZone: string;
}) {
  const s = data.shipment!;
  const tr = s.tracking!;
  const at = (iso: string) => formatDateTimeCs(iso, timeZone);
  const { busy, run } = useAttempt();
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    const result = await run('tracking', (requestId) => send('tracking/refresh', { requestId }));
    if (result.ok) {
      setError(null);
      onDone();
    } else if (result.error) {
      setError(uncertain(result.error) ? shipmentsCs.uncertain : orderErrorText(result.error));
    }
  }
  const warnings = s.parcels.flatMap((p) =>
    p.tracking?.warning
      ? [
          {
            parcelNo: p.parcelNo,
            number: p.carrierParcelNumber,
            problem: t.meaning[p.tracking.warning.meaning]!,
            carrierText: p.tracking.warning.name,
          },
        ]
      : [],
  );
  return (
    <Card
      title={t.title}
      testId="tracking-card"
      action={
        canRefresh && tr.stopped !== 'DELIVERED' ? (
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy}
            onClick={() => void refresh()}
            data-testid="tracking-refresh"
          >
            {busy ? t.refreshing : t.refresh}
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-base font-semibold" data-testid="tracking-summary">
          {t.summary(tr.pickedUp, tr.delivered, tr.parcels)}
        </p>
        <p className="text-stone-600" data-testid="tracking-checked">
          {tr.lastSuccessAt ? t.checked(at(tr.lastSuccessAt)) : t.neverChecked}
          {tr.stopped === 'DELIVERED' && <> {t.done}</>}
        </p>
        {tr.lastError && tr.lastAttemptAt && (
          <Notice tone="warning">
            <span data-testid="tracking-failed">
              {t.failed(at(tr.lastAttemptAt), tr.lastError)}
            </span>
          </Notice>
        )}
        {tr.stopped === 'GAVE_UP' && (
          <Notice tone="warning">
            <span data-testid="tracking-paused">{t.paused(tr.failures)}</span>
          </Notice>
        )}
        {warnings.length > 0 && (
          <Notice tone="warning">
            <ul className="flex flex-col gap-1" data-testid="tracking-warnings">
              {warnings.map((w) => (
                <li key={w.parcelNo} data-testid={`tracking-warning-${w.parcelNo}`}>
                  <span className="font-medium">{t.warning(w.parcelNo, w.number, w.problem)}</span>
                  {w.carrierText && <> {t.carrierSays(w.carrierText)}</>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">{t.warningNote}</p>
          </Notice>
        )}
        {error && (
          <p role="alert" className="font-medium text-red-700" data-testid="tracking-error">
            {error}
          </p>
        )}
        <ul className="flex flex-col divide-y divide-stone-200">
          {s.parcels.map((p) => (
            <ParcelProgress key={p.parcelNo} parcel={p} at={at} />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ParcelProgress({ parcel, at }: { parcel: ShipmentParcel; at: (iso: string) => string }) {
  const tr = parcel.tracking;
  if (!tr) return null;
  const picked = tr.pickedUp;
  const step = tr.deliveredAt
    ? t.deliveredAt(at(tr.deliveredAt))
    : picked?.source === 'MANUAL'
      ? t.pickedManual(at(picked.at!))
      : picked?.source === 'CARRIER'
        ? t.pickedCarrier(at(picked.at!))
        : picked
          ? t.pickedImplied
          : t.waiting;
  return (
    <li className="flex flex-col gap-1 py-3" data-testid={`tracking-parcel-${parcel.parcelNo}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{shipmentsCs.parcel(parcel.parcelNo)}</span>
        <span className="font-mono text-xs">{parcel.crate}</span>
        {parcel.carrierParcelNumber && (
          <span className="font-mono text-xs">{parcel.carrierParcelNumber}</span>
        )}
      </div>
      <p data-testid={`tracking-parcel-${parcel.parcelNo}-state`}>
        {step}
        {/* A delivery without a pickup event: picked up, its time unknown — never invented. */}
        {tr.deliveredAt && picked?.source === 'CARRIER_IMPLIED' && (
          <span className="text-stone-600"> · {t.pickedImplied}</span>
        )}
      </p>
      {tr.last && (
        <p className="text-xs text-stone-600">
          {t.last(tr.last.name ?? t.meaning[tr.last.meaning]!, at(tr.last.occurredAt))}
        </p>
      )}
      {tr.missing && <p className="text-xs text-amber-900">{t.missing}</p>}
      {tr.events.length > 0 && (
        <details
          className="text-xs text-stone-600"
          data-testid={`tracking-history-${parcel.parcelNo}`}
        >
          <summary className="cursor-pointer">{t.history}</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {tr.events.map((e, i) => (
              <HistoryLine key={i} event={e} at={at} />
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function HistoryLine({ event: e, at }: { event: TrackingEvent; at: (iso: string) => string }) {
  return (
    <li className="wrap-anywhere">
      <span className="font-medium">{at(e.occurredAt)}</span> · {e.name ?? '–'} ·{' '}
      <span className="font-mono">{t.code(e.statusId, e.code)}</span> · {t.meaning[e.meaning]} ·{' '}
      {t.fetched(at(e.fetchedAt))}
    </li>
  );
}
