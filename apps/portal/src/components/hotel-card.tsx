import type { PortalDeliveries, PortalHotel } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate } from '@/lib/format';
import { orderWhen, StatePill, summarize } from './delivery-summary';

/**
 * A hotel on "Moje hotely" (owner 2026-11-11): its name, whether it has a current order and what
 * is happening with it (the core's state, the planned ship day), the next day of its active supply
 * plan apart from it, and the ways to its deliveries and its profile. Nothing else.
 */
export function HotelCard({
  hotel,
  deliveries,
  today,
}: {
  hotel: PortalHotel;
  deliveries: PortalDeliveries | null;
  today: string;
}) {
  const s = deliveries ? summarize(deliveries) : null;
  const t = cs.allDeliveries;
  return (
    <article
      className="flex h-full flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
      aria-labelledby={`hotel-${hotel.id}`}
    >
      <div>
        <h2 id={`hotel-${hotel.id}`} className="text-lg font-semibold text-stone-900">
          {hotel.name}
        </h2>
        <p className="text-sm text-stone-500">
          {hotel.addressLine1}, {hotel.postalCode} {hotel.city}
        </p>
      </div>
      <div className="flex flex-col gap-2" data-testid="home-dispatch">
        {s === null ? (
          <p className="text-sm text-amber-800" data-testid="home-dispatch-unavailable">
            {cs.home.unavailable}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1" data-testid="home-next-dispatch">
              <span className="text-xs text-stone-500">{t.columns.order}</span>
              {s.current ? (
                <span className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
                  <StatePill state={s.current.state} />
                  {orderWhen(s.current, today)}
                </span>
              ) : (
                <span className="text-sm text-stone-500">{t.noOrder}</span>
              )}
              {s.otherOrders > 0 && (
                <span className="text-xs text-stone-500">
                  {cs.deliveries.moreOrders(s.otherOrders)}
                </span>
              )}
            </div>
            {s.nextPlanDay && (
              <p
                className="flex flex-wrap items-baseline gap-x-2 text-sm text-stone-700"
                data-testid="home-next-plan"
              >
                <span className="rounded border border-dashed border-stone-400 px-1.5 text-xs text-stone-600">
                  {cs.deliveries.planBadge}
                </span>
                {formatDate(s.nextPlanDay.shipDate)}
                <span className="text-xs text-stone-500">{t.planNote}</span>
              </p>
            )}
          </>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        <Link
          href={`/hotels/${hotel.id}/deliveries`}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          aria-label={`${t.open}: ${hotel.name}`}
        >
          {t.open}
        </Link>
        <Link
          href={`/hotels/${hotel.id}`}
          className="text-sm font-medium text-emerald-800 underline-offset-2 hover:underline"
          aria-label={`${cs.hotels.open}: ${hotel.name}`}
        >
          {cs.hotels.open}
        </Link>
      </div>
    </article>
  );
}
