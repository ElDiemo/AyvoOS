import type { PortalDeliveries, PortalDelivery } from '@ayvo/types';
import { cs } from '@/i18n/cs';
import { formatDate, formatDateTime } from '@/lib/format';

const t = cs.deliveries;

/**
 * A hotel's deliveries at a glance (owner 2026-11-11, hotel-first): the nearest REAL order — one
 * the carrier has or is about to take first, else the soonest planned one — how many other current
 * orders there are, and apart from them the nearest day of the switched-on supply plan that has no
 * order yet. Built only from the contract's answer: states are the core's (from real events), the
 * plan days only from an active plan; nothing is estimated.
 */
export function summarize(d: PortalDeliveries) {
  const current = d.inProgress[0] ?? d.planned[0] ?? null;
  return {
    current,
    otherOrders: d.inProgress.length + d.planned.length - (current ? 1 : 0),
    nextPlanDay: d.upcoming[0] ?? null,
    lastDelivered: d.delivered[0] ?? null,
  };
}

const tone: Record<PortalDelivery['state'], { pill: string; dot: string }> = {
  PLANNED: { pill: 'bg-stone-50 text-stone-700 ring-stone-200', dot: 'bg-stone-400' },
  PREPARED: { pill: 'bg-amber-50 text-amber-900 ring-amber-200/80', dot: 'bg-amber-500' },
  READY_FOR_PICKUP: { pill: 'bg-amber-50 text-amber-900 ring-amber-200/80', dot: 'bg-amber-500' },
  IN_TRANSIT: { pill: 'bg-sky-50 text-sky-900 ring-sky-200/80', dot: 'bg-sky-500' },
  DELIVERED: { pill: 'bg-emerald-50 text-emerald-900 ring-emerald-200/80', dot: 'bg-emerald-600' },
};

/** The order's state as the hotel sees it (the core's, from real events). */
export function StatePill({ state }: { state: PortalDelivery['state'] }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${tone[state].pill}`}
      data-testid="state"
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${tone[state].dot}`} />
      {t.states[state]}
    </span>
  );
}

/** The same words as `orderWhen`, its date set apart in weight (no other change of text). */
export function OrderWhen({ d, today }: { d: PortalDelivery; today: string }) {
  const text = orderWhen(d, today);
  const m = /^(.*?)(\d{1,2}\. \d{1,2}\. \d{4}(?: \d{1,2}:\d{2})?)$/.exec(text);
  if (!m) return <span className="font-medium text-stone-900">{text}</span>;
  return (
    <span className="text-stone-600">
      {m[1]}
      <span className="font-semibold text-stone-900 tabular-nums">{m[2]}</span>
    </span>
  );
}

/** The marker of a supply-plan day: indicative, never an order. */
export function PlanBadge() {
  return (
    <span className="inline-flex h-5 items-center rounded-md border border-dashed border-stone-400/80 px-1.5 text-[11px] font-medium text-stone-600">
      {t.planBadge}
    </span>
  );
}

/** The portal's two button weights (one look for every card and line). */
export const primaryButton =
  'inline-flex h-10 items-center justify-center rounded-lg bg-emerald-900 px-4 text-sm font-semibold whitespace-nowrap text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800';
/** A white surface: soft border and shadow, rounded. */
export const surface =
  'rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04),0_1px_3px_rgba(28,25,23,0.05)]';
/** A small section label. */
export const label = 'text-[11px] font-medium tracking-wider text-stone-500 uppercase';

/**
 * When, for an order — always the PLANNED SHIP day, never an arrival: handed to the carrier (its
 * reported moment), else the planned ship day; a ship day that has passed before the order left
 * says "Odešleme co nejdřív" (never "Na cestě" without the carrier's event).
 */
export function orderWhen(d: PortalDelivery, today: string): string {
  if (d.state === 'DELIVERED' && d.deliveredAt) return t.deliveredOn(formatDateTime(d.deliveredAt));
  if (d.handedOverAt) return t.handedOverOn(formatDateTime(d.handedOverAt));
  if (d.state !== 'IN_TRANSIT' && d.shipDate < today) return t.asap;
  return t.shipOn(formatDate(d.shipDate));
}

/** Products in whole crates, in one short line ("Tekuté mýdlo 330 ml · 1 bedna"). */
export function itemsLine(lines: { product: string; crates: number }[]): string {
  if (lines.length === 0) return '';
  const first = `${lines[0]!.product} · ${t.crates(lines[0]!.crates)}`;
  return lines.length === 1 ? first : `${first} ${t.moreProducts(lines.length - 1)}`;
}

/** Today in Europe/Prague as YYYY-MM-DD (ship days are calendar days of that zone). */
export function pragueToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);
}
