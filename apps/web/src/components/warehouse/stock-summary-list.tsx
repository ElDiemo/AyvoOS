import type { StockSummary } from '@ayvo/types';
import { unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { StockFigures } from './stock-list';
import { stockState, StockStateBadge } from './stock-state';

const i = warehouseCs.inventory;

/**
 * The planning list on Zásoby (inventory:stock_summary only): item, K dispozici, Rezervováno and
 * the state, from the limited stock-summary contract only — no lots, suppliers, prices, documents,
 * movements or on-hand counts (the API never sends them).
 */
export function StockSummaryList({ summary }: { summary: StockSummary }) {
  if (summary.items.length === 0) return <p className="text-sm text-stone-500">{i.empty}</p>;
  return (
    <ul className="divide-y divide-stone-100" data-testid="availability">
      {summary.items.map((row) => (
        <li
          key={row.item.code}
          className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
          data-testid={`availability-${row.item.code}`}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium wrap-anywhere">{row.item.name}</span>
            <span className="font-mono text-xs text-stone-500">{row.item.code}</span>
            <StockStateBadge
              state={stockState(row.available, row.lowStock)}
              testId={`availability-state-${row.item.code}`}
            />
          </span>
          <StockFigures
            available={row.available}
            reserved={row.reserved}
            unit={unitCs(row.item.unitCode)}
          />
        </li>
      ))}
    </ul>
  );
}
