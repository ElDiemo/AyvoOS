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

const tone: Record<PortalDelivery['state'], string> = {
  PLANNED: 'bg-stone-100 text-stone-800 ring-stone-300',
  PREPARED: 'bg-amber-50 text-amber-900 ring-amber-200',
  READY_FOR_PICKUP: 'bg-amber-50 text-amber-900 ring-amber-200',
  IN_TRANSIT: 'bg-sky-50 text-sky-900 ring-sky-200',
  DELIVERED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
};

/** The order's state as the hotel sees it (the core's, from real events). */
export function StatePill({ state }: { state: PortalDelivery['state'] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${tone[state]}`}
      data-testid="state"
    >
      {t.states[state]}
    </span>
  );
}

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
