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
}: {
  title: string;
  empty: string;
  help?: string;
  items: PortalDelivery[];
  testId: string;
}) {
  return (
    <section
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`${testId}-title`} className="text-base font-semibold text-stone-900">
          {title} <span className="font-normal text-stone-500">({items.length})</span>
        </h2>
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

/** The three groups of a hotel's deliveries. */
export function DeliveryGroups({ deliveries }: { deliveries: PortalDeliveries }) {
  return (
    <div className="flex flex-col gap-4">
      <Group
        title={t.inProgress}
        empty={t.noInProgress}
        items={deliveries.inProgress}
        testId="deliveries-in-progress"
      />
      <Group
        title={t.planned}
        empty={t.noPlanned}
        items={deliveries.planned}
        testId="deliveries-planned"
      />
      <Group
        title={t.delivered}
        empty={t.noDelivered}
        help={t.deliveredHelp(20)}
        items={deliveries.delivered}
        testId="deliveries-delivered"
      />
    </div>
  );
}

/** On the profile: the nearest delivery (on the way first, then planned) and the way to all. */
export function NextDeliveryCard({
  hotelId,
  deliveries,
}: {
  hotelId: string;
  deliveries: PortalDeliveries | null;
}) {
  const next = deliveries ? (deliveries.inProgress[0] ?? deliveries.planned[0] ?? null) : null;
  return (
    <section
      aria-labelledby="next-delivery-title"
      data-testid="profile-next-delivery"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="next-delivery-title" className="text-base font-semibold text-stone-900">
          {t.next}
        </h2>
        {deliveries === null ? (
          <p className="text-sm text-amber-800">{t.unavailable}</p>
        ) : next ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-stone-700">
            <State state={next.state} /> {formatDate(next.shipDate)}
          </p>
        ) : (
          <p className="text-sm text-stone-500 italic">{t.none}</p>
        )}
      </div>
      <Link
        href={`/hotels/${hotelId}/deliveries`}
        className="text-sm font-medium text-emerald-800 underline-offset-2 hover:underline"
      >
        {t.open} <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
