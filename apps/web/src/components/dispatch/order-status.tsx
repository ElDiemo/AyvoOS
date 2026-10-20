import type { OrderSummary } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { ordersCs } from '@/i18n/cs/orders';

/** Order state; an open order with crates is shown as "Rozpracovaná" (picking in progress). */
export function orderState(o: Pick<OrderSummary, 'status' | 'totals'>): string {
  return o.status === 'OPEN' && o.totals.loadedCrates > 0 ? 'PICKING' : o.status;
}

const tone: Record<string, string> = {
  OPEN: 'border-stone-300 bg-white text-stone-800',
  PICKING: 'border-amber-300 bg-amber-50 text-amber-950',
  READY_TO_DISPATCH: 'border-sky-300 bg-sky-50 text-sky-950',
  READY_FOR_PICKUP: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  HANDED_TO_CARRIER: 'border-violet-300 bg-violet-50 text-violet-900',
  DELIVERED: 'border-stone-300 bg-stone-100 text-stone-800',
  CANCELLED: 'border-stone-200 bg-stone-100 text-stone-500',
};

export function OrderStatusBadge({ order }: { order: Pick<OrderSummary, 'status' | 'totals'> }) {
  const state = orderState(order);
  return (
    <span
      data-testid="order-status"
      data-status={state}
      className={cn(
        'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tone[state],
      )}
    >
      {ordersCs.status[state] ?? state}
    </span>
  );
}
