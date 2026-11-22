import { cn } from '@ayvo/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';

export type StockState = 'none' | 'low' | 'ok';

/**
 * How an item reads on Sklad → Zásoby, from the API's own figures only (no new stock state, no
 * new calculation): nothing available (zero or less) → "Nic k dispozici", whether or not a minimum
 * is set; otherwise the API's low-stock flag (available below the set minimum) → "Pod minimem".
 */
export function stockState(available: string, lowStock: boolean): StockState {
  if (/^-|^0+(\.0*)?$/.test(available.trim())) return 'none';
  return lowStock ? 'low' : 'ok';
}

const tone: Record<StockState, string> = {
  none: 'bg-red-100 text-red-900',
  low: 'bg-amber-100 text-amber-900',
  ok: 'bg-stone-100 text-stone-700',
};

export function StockStateBadge({ state, testId }: { state: StockState; testId?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone[state],
      )}
      data-testid={testId}
      data-state={state}
    >
      {warehouseCs.inventory.state[state]}
    </span>
  );
}
