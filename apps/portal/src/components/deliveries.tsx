import type { PortalDeliveries } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate, formatDateTime } from '@/lib/format';
import { StatePill as State } from './delivery-summary';

const t = cs.deliveries;

/** Products of one dispatch: whole crates (and bottles for a real order). */
function Items({ lines }: { lines: { product: string; crates: number; bottles?: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-2" data-testid="next-items">
      {lines.map((l) => (
        <li
          key={l.product}
          className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-700"
        >
          {l.product} · {t.crates(l.crates)}
          {l.bottles !== undefined && ` (${t.bottles(l.bottles)})`}
        </li>
      ))}
    </ul>
  );
}

/**
 * The hotel's dispatch at a glance on its profile (#169 P0 2): the nearest planned dispatch — a
 * real order with its state, products and quantities, else a supply-plan day marked "Podle plánu"
 * with its crates; a planned order whose ship day has passed says "Odešleme co nejdřív" — and,
 * apart, the latest real shipment: on the way (with the carrier's hand-over moment when it was
 * reported, never otherwise) or the last delivery with the carrier's moment. Planned ship days are
 * never presented as deliveries, and no arrival estimate is given.
 */
export function NextDeliveryCard({
  hotelId,
  deliveries,
  today,
}: {
  hotelId: string;
  deliveries: PortalDeliveries | null;
  /** Today in the hotel's zone (YYYY-MM-DD), for a ship day that has passed. */
  today: string;
}) {
  const planned = deliveries?.planned[0] ?? null;
  const byPlan = deliveries && !planned ? (deliveries.upcoming[0] ?? null) : null;
  const onTheWay = deliveries?.inProgress[0] ?? null;
  const lastDelivered = deliveries?.delivered[0] ?? null;
  const h = cs.home;
  return (
    <section
      aria-labelledby="next-delivery-title"
      data-testid="profile-next-delivery"
      className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="next-delivery-title" className="text-base font-semibold text-stone-900">
          {t.next}
        </h2>
        <Link
          href={`/hotels/${hotelId}/deliveries`}
          className="text-sm font-medium text-emerald-800 underline-offset-2 hover:underline"
        >
          {t.open} <span aria-hidden="true">→</span>
        </Link>
      </div>
      {deliveries === null ? (
        <p className="text-sm text-amber-800">{t.unavailable}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2" data-testid="next-dispatch">
            <h3 className="text-xs text-stone-500">{h.nextDispatch}</h3>
            {planned ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
                  <State state={planned.state} />
                  {planned.shipDate < today ? h.asap : formatDate(planned.shipDate)}
                </p>
                <Items lines={planned.lines} />
              </>
            ) : byPlan ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
                  <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700">
                    {t.byPlan}
                  </span>
                  {formatDate(byPlan.shipDate)}
                </p>
                <Items lines={byPlan.lines} />
              </>
            ) : (
              <p className="text-sm text-stone-500 italic">{h.noDispatch}</p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2" data-testid="last-shipment">
            <h3 className="text-xs text-stone-500">{h.lastShipment}</h3>
            {onTheWay ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
                  <State state={onTheWay.state} />
                  {onTheWay.handedOverAt
                    ? h.handedOver(formatDateTime(onTheWay.handedOverAt))
                    : h.planned(formatDate(onTheWay.shipDate))}
                </p>
                <Items lines={onTheWay.lines} />
              </>
            ) : lastDelivered?.deliveredAt ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
                  <State state="DELIVERED" />
                  {formatDateTime(lastDelivered.deliveredAt)}
                </p>
                <Items lines={lastDelivered.lines} />
              </>
            ) : (
              <p className="text-sm text-stone-500 italic">{h.noShipments}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
