import type { PortalDeliveries } from '@ayvo/types';
import { cs } from '@/i18n/cs';
import { formatDate, formatDateTime } from '@/lib/format';

const t = cs.home;
const states = cs.deliveries.states;

/** Today in Europe/Prague as YYYY-MM-DD (planned ship days are calendar days of that zone). */
export function pragueToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);
}

/**
 * The hotel's dispatch at a glance on "Moje hotely" (owner 2026-11-10): the nearest planned
 * dispatch (an order, else a supply-plan day marked "Podle plánu"; a planned order whose day has
 * passed says "Odešleme co nejdřív" instead of a past date) and the latest shipments — on the way
 * with the moment they were handed to the carrier, and the last delivery with its delivery moment.
 * Planned ship days and real deliveries are labelled apart; no arrival estimate is ever given.
 */
export function HotelDispatch({
  deliveries,
  today,
}: {
  deliveries: PortalDeliveries | null;
  today: string;
}) {
  if (deliveries === null)
    return (
      <p className="text-sm text-amber-800" data-testid="home-dispatch-unavailable">
        {t.unavailable}
      </p>
    );
  const planned = deliveries.planned[0] ?? null;
  const byPlan = planned ? null : (deliveries.upcoming[0] ?? null);
  const onTheWay = deliveries.inProgress;
  const lastDelivered = deliveries.delivered[0] ?? null;
  return (
    <dl className="flex flex-col gap-2 text-sm" data-testid="home-dispatch">
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-stone-500">{t.nextDispatch}</dt>
        <dd className="text-stone-800" data-testid="home-next-dispatch">
          {planned ? (
            <>
              {planned.shipDate < today ? t.asap : formatDate(planned.shipDate)}
              <span className="text-stone-500"> · {states[planned.state]}</span>
            </>
          ) : byPlan ? (
            <>
              {formatDate(byPlan.shipDate)}
              <span className="text-stone-500"> · {cs.deliveries.byPlan}</span>
            </>
          ) : (
            <span className="text-stone-500 italic">{t.noDispatch}</span>
          )}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-stone-500">{t.latest}</dt>
        <dd className="flex flex-col gap-0.5 text-stone-800" data-testid="home-latest">
          {onTheWay.slice(0, 3).map((d) => (
            <span key={d.code}>
              {states[d.state]}
              {d.handedOverAt ? (
                <span className="text-stone-500">
                  {' '}
                  · {t.handedOver(formatDateTime(d.handedOverAt))}
                </span>
              ) : (
                <span className="text-stone-500"> · {t.planned(formatDate(d.shipDate))}</span>
              )}
            </span>
          ))}
          {onTheWay.length > 3 && (
            <span className="text-stone-500">{t.more(onTheWay.length - 3)}</span>
          )}
          {lastDelivered?.deliveredAt && (
            <span>{t.lastDelivered(formatDateTime(lastDelivered.deliveredAt))}</span>
          )}
          {onTheWay.length === 0 && !lastDelivered && (
            <span className="text-stone-500 italic">{t.noShipments}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}
