import type { PortalDeliveries, PortalHotel } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate } from '@/lib/format';
import { orderWhen, StatePill, summarize } from './delivery-summary';

const t = cs.allDeliveries;

/**
 * "Dodávky": one short line per hotel (owner 2026-11-11, hotel-first) — the hotel, its nearest
 * real order with its state and planned ship day, apart from it the nearest day of its active
 * supply plan that has no order yet, and "Zobrazit dodávky". A hotel with neither says so once.
 * Desktop: compact rows under column headings; phone: one card per hotel.
 */
export function HotelDeliveriesList({
  hotels,
  deliveries,
  today,
}: {
  hotels: PortalHotel[];
  deliveries: Map<string, PortalDeliveries | null>;
  today: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_auto] gap-6 border-b border-stone-200 bg-stone-50 px-5 py-2.5 text-xs font-medium tracking-wide text-stone-500 uppercase md:grid"
      >
        <span>{t.columns.hotel}</span>
        <span>{t.columns.order}</span>
        <span>{t.columns.plan}</span>
        <span className="w-36" />
      </div>
      <ul className="divide-y divide-stone-200" data-testid="deliveries-hotels">
        {hotels.map((h) => (
          <HotelRow key={h.id} hotel={h} deliveries={deliveries.get(h.id) ?? null} today={today} />
        ))}
      </ul>
    </div>
  );
}

function HotelRow({
  hotel,
  deliveries,
  today,
}: {
  hotel: PortalHotel;
  deliveries: PortalDeliveries | null;
  today: string;
}) {
  const s = deliveries ? summarize(deliveries) : null;
  const empty = s !== null && !s.current && !s.nextPlanDay;
  return (
    <li
      className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-6"
      data-testid={`deliveries-hotel-${hotel.id}`}
    >
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-stone-900">{hotel.name}</h2>
        <p className="truncate text-xs text-stone-500">{hotel.city}</p>
      </div>
      {s === null ? (
        <p className="text-sm text-amber-800 md:col-span-2" data-testid="row-unavailable">
          {t.unavailable}
        </p>
      ) : empty ? (
        <p className="text-sm text-stone-500 md:col-span-2" data-testid="row-empty">
          {t.nothing}
        </p>
      ) : (
        <>
          <div className="min-w-0" data-testid="row-order">
            <p className="text-xs text-stone-500 md:sr-only">{t.order}</p>
            {s.current ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatePill state={s.current.state} />
                <span className="text-sm text-stone-800">{orderWhen(s.current, today)}</span>
                {s.otherOrders > 0 && (
                  <span className="text-xs text-stone-500">
                    {cs.deliveries.moreOrders(s.otherOrders)}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-stone-500">{t.noOrder}</p>
            )}
          </div>
          <div className="min-w-0" data-testid="row-plan">
            <p className="text-xs text-stone-500 md:sr-only">{t.plan}</p>
            {s.nextPlanDay ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-stone-700">
                <span className="rounded border border-dashed border-stone-400 px-1.5 text-xs text-stone-600">
                  {cs.deliveries.planBadge}
                </span>
                <span>{formatDate(s.nextPlanDay.shipDate)}</span>
                <span className="text-xs text-stone-500">{t.planNote}</span>
              </p>
            ) : (
              <p className="text-sm text-stone-400">{t.noPlan}</p>
            )}
          </div>
        </>
      )}
      <Link
        href={`/hotels/${hotel.id}/deliveries`}
        className="inline-flex w-full items-center justify-center rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold whitespace-nowrap text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 md:w-36"
        aria-label={`${t.open}: ${hotel.name}`}
      >
        {t.open}
      </Link>
    </li>
  );
}
