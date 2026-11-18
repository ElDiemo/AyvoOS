import type { StockItem, Supplier } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { Field, FieldList } from '@/components/ui';
import { formatDateTimeCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { ItemSettingsForm } from './item-settings-form';
import { StockIssueForm } from './stock-issue-form';
import { stockState, StockStateBadge } from './stock-state';

const i = warehouseCs.inventory;
const s = warehouseCs.stock;

/** Three figures of one item, always with the unit; readable side by side at 320 px. */
export function StockFigures({
  available,
  reserved,
  onHand,
  unit,
}: {
  available: string;
  reserved: string;
  onHand?: string;
  unit: string;
}) {
  const cells: [string, string][] = [
    [i.available, available],
    [i.reserved, reserved],
    ...(onHand === undefined ? [] : ([[i.onHand, onHand]] as [string, string][])),
  ];
  return (
    <dl
      className={cn(
        'grid gap-3 text-right sm:shrink-0',
        onHand === undefined ? 'grid-cols-2 sm:w-56' : 'grid-cols-3 sm:w-80',
      )}
    >
      {cells.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] tracking-wide text-stone-500 uppercase">{label}</dt>
          <dd className="font-semibold tabular-nums">
            {formatQuantityCs(value)} <span className="text-xs font-normal">{unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The warehouse's list on Zásoby (inventory:read): one row per item (K dispozici, Rezervováno,
 * Na skladě, the state); a row opens its lots, a link to its movements, the issue (with
 * inventory:consume, as on the former Stav skladu) and the planning settings (changed with
 * inventory:items_manage — the API checks it again).
 */
export function StockList({
  items,
  suppliers,
  tz,
  canIssue,
  canPlan,
  open,
}: {
  items: StockItem[];
  suppliers: Supplier[];
  tz: string;
  canIssue: boolean;
  canPlan: boolean;
  /** An item code opened from the URL (?item=). */
  open?: string;
}) {
  if (items.length === 0) return <p className="text-sm text-stone-500">{i.empty}</p>;
  return (
    <ul className="divide-y divide-stone-100" data-testid="stock-list">
      {items.map((entry) => {
        const unit = unitCs(entry.item.unit.code);
        const state = stockState(entry.available, entry.lowStock);
        const settings = entry.item.settings;
        return (
          <li key={entry.item.id}>
            <details
              className="group"
              open={open === entry.item.code}
              data-testid={`stock-${entry.item.code}`}
            >
              <summary className="flex cursor-pointer list-none flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    aria-hidden
                    className="text-stone-400 transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                  <span className="font-medium wrap-anywhere">{entry.item.name}</span>
                  <span className="font-mono text-xs text-stone-500">{entry.item.code}</span>
                  <StockStateBadge state={state} testId={`stock-state-${entry.item.code}`} />
                </span>
                <StockFigures
                  available={entry.available}
                  reserved={entry.reserved}
                  onHand={entry.onHand}
                  unit={unit}
                />
              </summary>
              <div className="flex flex-col gap-5 pb-5 pl-4 text-sm">
                {entry.suggestedQuantity && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
                    {s.suggestion(formatQuantityCs(entry.suggestedQuantity), unit)}
                  </p>
                )}
                {entry.item.lotTracked && (
                  <section>
                    <h3 className="mb-2 font-medium">{s.lots}</h3>
                    {entry.lots.length === 0 ? (
                      <p className="text-stone-500">{s.noLots}</p>
                    ) : (
                      <ul
                        className="divide-y divide-stone-100"
                        data-testid={`lots-${entry.item.code}`}
                      >
                        {entry.lots.map((lot) => (
                          <li
                            key={lot.id}
                            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                          >
                            <span className="min-w-0">
                              <Link
                                href={`/warehouse/movements?lotId=${lot.id}`}
                                className="font-mono wrap-anywhere hover:underline"
                              >
                                {lot.code}
                              </Link>
                              <span className="block text-xs text-stone-500 wrap-anywhere">
                                {s.lotKind[lot.kind]}
                                {lot.supplier ? ` · ${lot.supplier.name}` : ''} ·{' '}
                                {formatDateTimeCs(lot.createdAt, tz)}
                              </span>
                            </span>
                            <span className="font-semibold whitespace-nowrap tabular-nums">
                              {formatQuantityCs(lot.onHand)} {unit}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
                <p>
                  <Link
                    href={`/warehouse/movements?item=${encodeURIComponent(entry.item.code)}`}
                    className="underline"
                    data-testid={`stock-movements-${entry.item.code}`}
                  >
                    {i.itemMovements}
                  </Link>
                </p>
                {entry.item.kind === 'CONSUMABLE' && canIssue && (
                  <section aria-labelledby={`issue-${entry.item.code}-title`}>
                    <h3 id={`issue-${entry.item.code}-title`} className="mb-1 font-medium">
                      {warehouseCs.issue.title}
                    </h3>
                    <p className="mb-3 text-xs text-stone-500">{warehouseCs.issue.help}</p>
                    <StockIssueForm item={entry.item} onHand={entry.onHand} lots={entry.lots} />
                  </section>
                )}
                <section data-testid={`planning-${entry.item.code}`}>
                  <h3 className="mb-2 font-medium">{s.settings}</h3>
                  {settings ? (
                    <FieldList>
                      <Field label={s.reorderPoint}>{settings.reorderPoint ?? '—'}</Field>
                      <Field label={s.targetLevel}>{settings.targetLevel ?? '—'}</Field>
                    </FieldList>
                  ) : (
                    <p className="text-stone-500">{s.noSettings}</p>
                  )}
                  {!settings?.reorderPoint && (
                    <p
                      className="mt-2 text-amber-900"
                      data-testid={`no-minimum-${entry.item.code}`}
                    >
                      {i.noMinimum}
                    </p>
                  )}
                  {canPlan && (
                    <div className="mt-3">
                      <ItemSettingsForm item={entry.item} suppliers={suppliers} />
                    </div>
                  )}
                </section>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
