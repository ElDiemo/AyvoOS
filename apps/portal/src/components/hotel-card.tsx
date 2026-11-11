import type { PortalDeliveries, PortalHotel } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate } from '@/lib/format';
import {
  label,
  OrderWhen,
  PlanBadge,
  primaryButton,
  StatePill,
  summarize,
  surface,
} from './delivery-summary';

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
      className={`flex h-full flex-col gap-5 p-6 transition-shadow hover:shadow-md ${surface}`}
      aria-labelledby={`hotel-${hotel.id}`}
    >
      <div>
        <h2
          id={`hotel-${hotel.id}`}
          className="text-lg leading-snug font-semibold tracking-tight text-stone-900"
        >
          {hotel.name}
        </h2>
        <p className="mt-0.5 text-sm text-stone-500">
          {hotel.addressLine1}, {hotel.postalCode} {hotel.city}
        </p>
      </div>
      <div
        className="flex flex-col gap-3 border-t border-stone-100 pt-4"
        data-testid="home-dispatch"
      >
        {s === null ? (
          <p className="text-sm text-amber-800" data-testid="home-dispatch-unavailable">
            {cs.home.unavailable}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5" data-testid="home-next-dispatch">
              <span className={label}>{t.columns.order}</span>
              {s.current ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <StatePill state={s.current.state} />
                  <OrderWhen d={s.current} today={today} />
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
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-700"
                data-testid="home-next-plan"
              >
                <PlanBadge />
                <span className="font-medium tabular-nums">
                  {formatDate(s.nextPlanDay.shipDate)}
                </span>
                <span className="text-xs text-stone-500">{t.planNote}</span>
              </p>
            )}
          </>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        <Link
          href={`/hotels/${hotel.id}/deliveries`}
          className={primaryButton}
          aria-label={`${t.open}: ${hotel.name}`}
        >
          {t.open}
        </Link>
        <Link
          href={`/hotels/${hotel.id}`}
          className="inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-emerald-800 underline-offset-4 transition-colors hover:text-emerald-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          aria-label={`${cs.hotels.open}: ${hotel.name}`}
        >
          {cs.hotels.open}
        </Link>
      </div>
    </article>
  );
}
