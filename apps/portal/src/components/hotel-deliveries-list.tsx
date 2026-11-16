import type { PortalDeliveries, PortalHotel } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate } from '@/lib/format';
import {
  OrderWhen,
  PlanBadge,
  primaryButton,
  StatePill,
  summarize,
  surface,
} from './delivery-summary';

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
    <div className={`overflow-hidden ${surface}`}>
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_auto] gap-6 border-b border-stone-200/80 bg-stone-50/70 px-6 py-3 text-[11px] font-medium tracking-wider text-stone-500 uppercase md:grid"
      >
        <span>{t.columns.hotel}</span>
        <span>{t.columns.order}</span>
        <span>{t.columns.plan}</span>
        <span className="w-40" />
      </div>
      <ul className="divide-y divide-stone-100" data-testid="deliveries-hotels">
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
      className="grid grid-cols-1 gap-3 px-5 py-5 transition-colors hover:bg-stone-50/60 sm:px-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-6"
      data-testid={`deliveries-hotel-${hotel.id}`}
    >
      <div className="min-w-0">
        <h2 className="truncate text-[15px] leading-snug font-semibold tracking-tight text-stone-900">
          {hotel.name}
        </h2>
        <p className="mt-0.5 truncate text-xs text-stone-500">{hotel.city}</p>
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
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <StatePill state={s.current.state} />
                <OrderWhen d={s.current} today={today} />
                {s.otherOrders > 0 && (
                  <span className="basis-full text-xs text-stone-500">
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
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-700">
                <PlanBadge />
                <span className="font-medium tabular-nums">
                  {formatDate(s.nextPlanDay.shipDate)}
                </span>
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
        className={`${primaryButton} w-full md:w-40`}
        aria-label={`${t.open}: ${hotel.name}`}
      >
        {t.open}
      </Link>
    </li>
  );
}
