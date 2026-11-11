import type { PortalDeliveries, PortalDelivery } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { formatDate, formatDateTime } from '@/lib/format';

const t = cs.deliveries;

const tone: Record<PortalDelivery['state'], string> = {
  PLANNED: 'bg-stone-100 text-stone-700',
  PREPARED: 'bg-amber-50 text-amber-900',
  READY_FOR_PICKUP: 'bg-amber-50 text-amber-900',
  IN_TRANSIT: 'bg-sky-50 text-sky-900',
  DELIVERED: 'bg-emerald-50 text-emerald-900',
};

function State({ state }: { state: PortalDelivery['state'] }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[state]}`}>
      {t.states[state]}
    </span>
  );
}

/** One delivery: its state, when, what (products in whole crates). */
export function DeliveryRow({ d }: { d: PortalDelivery }) {
  return (
    <li
      className="flex flex-col gap-2 border-t border-stone-100 py-3 first:border-t-0 first:pt-0"
      data-testid={`delivery-${d.code}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <State state={d.state} />
          {d.fromPlan && <span className="text-xs text-stone-500">{t.fromPlan}</span>}
        </div>
        <span className="text-xs text-stone-500">
          {t.order} <span className="font-mono">{d.code}</span>
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-stone-500">{t.shipDate}</dt>
          <dd>{formatDate(d.shipDate)}</dd>
        </div>
        {d.handedOverAt && (
          <div>
            <dt className="text-xs text-stone-500">{t.handedOver}</dt>
            <dd>{formatDateTime(d.handedOverAt)}</dd>
          </div>
        )}
        {d.deliveredAt && (
          <div>
            <dt className="text-xs text-stone-500">{t.deliveredAt}</dt>
            <dd>{formatDateTime(d.deliveredAt)}</dd>
          </div>
        )}
      </dl>
      <ul className="flex flex-wrap gap-2">
        {d.lines.map((l) => (
          <li
            key={l.product}
            className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-700"
          >
            {l.product} · {t.crates(l.crates)} ({t.bottles(l.bottles)})
          </li>
        ))}
      </ul>
    </li>
  );
}

function Group({
  title,
  empty,
  help,
  items,
  testId,
  idPrefix,
  nested,
}: {
  title: string;
  empty: string;
  help?: string;
  items: PortalDelivery[];
  testId: string;
  /** Unique ids when several hotels' groups share a page. */
  idPrefix: string;
  /** Under a hotel's own heading (h3 instead of h2). */
  nested: boolean;
}) {
  const H = nested ? 'h3' : 'h2';
  return (
    <section
      aria-labelledby={`${idPrefix}${testId}-title`}
      data-testid={testId}
      className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <H id={`${idPrefix}${testId}-title`} className="text-base font-semibold text-stone-900">
          {title} <span className="font-normal text-stone-500">({items.length})</span>
        </H>
        {help && <p className="text-xs text-stone-500">{help}</p>}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-stone-500 italic">{empty}</p>
      ) : (
        <ul>
          {items.map((d) => (
            <DeliveryRow key={d.code} d={d} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Upcoming plan days: indicative ship days and whole crates (not orders yet). */
function UpcomingGroup({
  days,
  idPrefix,
  nested,
}: {
  days: PortalDeliveries['upcoming'];
  idPrefix: string;
  nested: boolean;
}) {
  const H = nested ? 'h3' : 'h2';
  return (
    <section
      aria-labelledby={`${idPrefix}deliveries-upcoming-title`}
      data-testid="deliveries-upcoming"
      className="flex flex-col gap-3 rounded-xl border border-dashed border-stone-300 bg-stone-50 p-5"
    >
      <div>
        <H
          id={`${idPrefix}deliveries-upcoming-title`}
          className="text-base font-semibold text-stone-900"
        >
          {t.upcoming} <span className="font-normal text-stone-500">({days.length})</span>
        </H>
        <p className="text-xs text-stone-500">{t.upcomingHelp}</p>
      </div>
      {days.length === 0 ? (
        <p className="text-sm text-stone-500 italic">{t.noUpcoming}</p>
      ) : (
        <ul className="flex flex-col">
          {days.map((d) => (
            <li
              key={d.shipDate}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 py-2 first:border-t-0 first:pt-0"
              data-testid={`upcoming-${d.shipDate}`}
            >
              <span className="text-sm font-medium text-stone-800">
                {t.shipDate}: {formatDate(d.shipDate)}
              </span>
              <span className="flex flex-wrap gap-2">
                {d.lines.map((l) => (
                  <span
                    key={l.product}
                    className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700"
                  >
                    {l.product} · {t.crates(l.crates)}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The groups of a hotel's deliveries, and what the supply plan still has ahead. */
export function DeliveryGroups({
  deliveries,
  idPrefix = '',
}: {
  deliveries: PortalDeliveries;
  /** Set on a page with several hotels: unique ids and the groups under the hotel's heading. */
  idPrefix?: string;
}) {
  const nested = idPrefix !== '';
  return (
    <div className="flex flex-col gap-4">
      <Group
        title={t.inProgress}
        empty={t.noInProgress}
        items={deliveries.inProgress}
        testId="deliveries-in-progress"
        idPrefix={idPrefix}
        nested={nested}
      />
      <Group
        title={t.planned}
        empty={t.noPlanned}
        items={deliveries.planned}
        testId="deliveries-planned"
        idPrefix={idPrefix}
        nested={nested}
      />
      <UpcomingGroup days={deliveries.upcoming} idPrefix={idPrefix} nested={nested} />
      <Group
        title={t.delivered}
        empty={t.noDelivered}
        help={t.deliveredHelp(20)}
        items={deliveries.delivered}
        testId="deliveries-delivered"
        idPrefix={idPrefix}
        nested={nested}
      />
    </div>
  );
}

/** On the profile: the nearest delivery (on the way first, then planned) and the way to all. */
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
