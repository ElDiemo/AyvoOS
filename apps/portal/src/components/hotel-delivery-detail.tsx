import type { PortalDeliveries, PortalDelivery } from '@ayvo/types';
import { cs } from '@/i18n/cs';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  itemsLine,
  label,
  OrderWhen,
  PlanBadge,
  StatePill,
  summarize,
  surface,
} from './delivery-summary';

const t = cs.deliveries;

/**
 * One hotel's deliveries (owner 2026-11-11, hotel-first): at the top what is happening with the
 * nearest real order and the next day of the active supply plan; below, its current orders (items
 * on demand), the supply plan for 60 days — set apart, never an order or a delivery date — and the
 * delivered history, folded. Only the contract's answer; no estimate, no invented date.
 */
export function HotelDeliveryDetail({
  deliveries,
  today,
}: {
  deliveries: PortalDeliveries;
  today: string;
}) {
  const s = summarize(deliveries);
  const current = [...deliveries.inProgress, ...deliveries.planned];
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label={t.nextOrder}
        className={`grid grid-cols-1 overflow-hidden sm:grid-cols-2 ${surface}`}
        data-testid="detail-summary"
      >
        <div className="flex flex-col gap-2.5 p-5 sm:p-6" data-testid="summary-order">
          <h2 className={label}>{t.nextOrder}</h2>
          {s.current ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatePill state={s.current.state} />
                <span className="text-base">
                  <OrderWhen d={s.current} today={today} />
                </span>
              </div>
              <p className="text-sm text-stone-600">{itemsLine(s.current.lines)}</p>
            </>
          ) : (
            <p className="text-sm text-stone-500">{t.noCurrent}</p>
          )}
        </div>
        <div
          className="flex flex-col gap-2.5 border-t border-dashed border-stone-300 bg-stone-50/70 p-5 sm:border-t-0 sm:border-l sm:p-6"
          data-testid="summary-plan"
        >
          <h2 className={label}>{t.nextPlan}</h2>
          {s.nextPlanDay ? (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <PlanBadge />
                <span className="text-base font-semibold text-stone-800 tabular-nums">
                  {formatDate(s.nextPlanDay.shipDate)}
                </span>
              </p>
              <p className="text-sm text-stone-600">
                {itemsLine(s.nextPlanDay.lines)} · {cs.allDeliveries.planNote}
              </p>
            </>
          ) : (
            <p className="text-sm text-stone-500">{cs.allDeliveries.noPlan}</p>
          )}
        </div>
      </section>

      <section
        aria-labelledby="current-title"
        className="flex flex-col gap-3"
        data-testid="detail-current"
      >
        <div>
          <h2 id="current-title" className="text-lg font-semibold tracking-tight text-stone-900">
            {t.current} <span className="font-normal text-stone-500">({current.length})</span>
          </h2>
          <p className="mt-0.5 text-xs text-stone-500">{t.currentHelp}</p>
        </div>
        {current.length === 0 ? (
          <p className={`px-5 py-4 text-sm text-stone-500 ${surface}`}>{t.noCurrent}</p>
        ) : (
          <ul className={`divide-y divide-stone-100 overflow-hidden ${surface}`}>
            {current.map((d) => (
              <OrderRow key={d.code} d={d} today={today} />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="plan-title"
        className="flex flex-col gap-3 rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 p-5 sm:p-6"
        data-testid="detail-plan"
      >
        <div>
          <h2 id="plan-title" className="text-lg font-semibold tracking-tight text-stone-800">
            {t.planTitle}
          </h2>
          <p className="mt-0.5 text-xs text-stone-500">{t.planHelp}</p>
        </div>
        {deliveries.upcoming.length === 0 ? (
          <p className="text-sm text-stone-500">{t.noPlanDays}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {deliveries.upcoming.map((d) => (
              <li
                key={d.shipDate}
                className="flex flex-col gap-0.5 rounded-xl border border-dashed border-stone-300 bg-white/70 px-3.5 py-2.5"
                data-testid={`plan-${d.shipDate}`}
              >
                <span className="text-[11px] font-medium tracking-wider text-stone-500 uppercase">
                  {t.planBadge}
                </span>
                <span className="text-sm font-semibold text-stone-800 tabular-nums">
                  {formatDate(d.shipDate)}
                </span>
                <span className="text-xs text-stone-600">{itemsLine(d.lines)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-title" data-testid="detail-history">
        {deliveries.delivered.length === 0 ? (
          <>
            <h2 id="history-title" className="text-lg font-semibold tracking-tight text-stone-900">
              {t.history}
            </h2>
            <p className="mt-1 text-sm text-stone-500">{t.noHistory}</p>
          </>
        ) : (
          <details className={`group ${surface}`}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-2xl px-5 py-4 hover:bg-stone-50/60 sm:px-6">
              <h2
                id="history-title"
                className="text-lg font-semibold tracking-tight text-stone-900"
              >
                {t.history}{' '}
                <span className="font-normal text-stone-500">({deliveries.delivered.length})</span>
              </h2>
              <span
                aria-hidden="true"
                className="inline-block size-2 rotate-45 border-r-2 border-b-2 border-stone-400 transition-transform group-open:rotate-[225deg]"
              />
            </summary>
            <ul className="divide-y divide-stone-100 border-t border-stone-100">
              {deliveries.delivered.map((d) => (
                <OrderRow key={d.code} d={d} today={today} />
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

/** One order in a line; its items, quantities and carrier moments on demand. */
function OrderRow({ d, today }: { d: PortalDelivery; today: string }) {
  return (
    <li data-testid={`order-${d.code}`}>
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-5 py-3.5 transition-colors hover:bg-stone-50/60 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:px-6">
          <span className="col-span-2 sm:col-span-1">
            <StatePill state={d.state} />
          </span>
          <span className="col-span-2 text-sm sm:col-span-1">
            <OrderWhen d={d} today={today} />
          </span>
          <span className="col-span-2 text-sm text-stone-600 sm:col-span-1 sm:truncate">
            {itemsLine(d.lines)}
          </span>
          <span className="col-start-3 row-start-1 text-xs text-stone-500 sm:col-start-auto sm:row-start-auto">
            <span className="sr-only">{t.details}</span>
            <span
              aria-hidden="true"
              className="inline-block size-2 rotate-45 border-r-2 border-b-2 border-stone-400 transition-transform group-open:rotate-[225deg]"
            />
          </span>
        </summary>
        <div className="flex flex-col gap-2 border-t border-stone-100 bg-stone-50/70 px-5 py-3.5 text-sm sm:px-6">
          <p className="text-xs text-stone-500">
            {t.order} <span className="font-mono">{d.code}</span>
            {d.fromPlan && <> · {t.fromPlan}</>}
          </p>
          <ul className="flex flex-col gap-1">
            {d.lines.map((l) => (
              <li key={l.product} className="text-stone-800">
                {l.product} — {t.crates(l.crates)} ({t.bottles(l.bottles)})
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-3">
            <div>
              <dt className="text-stone-500">{t.shipDate}</dt>
              {/* A passed ship day before the order left is never shown as a date. */}
              <dd>
                {!d.handedOverAt &&
                d.state !== 'IN_TRANSIT' &&
                d.state !== 'DELIVERED' &&
                d.shipDate < today
                  ? t.asap
                  : formatDate(d.shipDate)}
              </dd>
            </div>
            {d.handedOverAt && (
              <div>
                <dt className="text-stone-500">{t.handedOver}</dt>
                <dd>{formatDateTime(d.handedOverAt)}</dd>
              </div>
            )}
            {d.deliveredAt && (
              <div>
                <dt className="text-stone-500">{t.deliveredAt}</dt>
                <dd>{formatDateTime(d.deliveredAt)}</dd>
              </div>
            )}
          </dl>
        </div>
      </details>
    </li>
  );
}
