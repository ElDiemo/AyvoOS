import type { OrderDetail } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { ordersCs } from '@/i18n/cs/orders';

const t = ordersCs.detail;

/** Requested vs. loaded crates and bottles per product (large on the picking terminal). */
export function OrderLines({ order, large = false }: { order: OrderDetail; large?: boolean }) {
  return (
    <ul className={cn('grid gap-3', large ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1')}>
      {order.lines.map((l) => {
        const done = l.loadedCrates === l.requiredCrates;
        return (
          <li
            key={l.lineNo}
            data-testid={`line-${l.product.code}`}
            data-complete={done}
            className={cn(
              'rounded-lg border p-3',
              done ? 'border-emerald-300 bg-emerald-50' : 'border-stone-200 bg-white',
            )}
          >
            <p className="font-medium">{l.product.name}</p>
            <p className="text-xs text-stone-500">
              {l.crateType.name} · {t.perCrate(l.capacity)}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <dt className="text-xs text-stone-500">{t.loadedCrates}</dt>
                <dd
                  className={cn('font-bold tabular-nums', large ? 'text-4xl' : 'text-2xl')}
                  data-testid={`line-crates-${l.product.code}`}
                >
                  {l.loadedCrates} / {l.requiredCrates}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-stone-500">{t.loadedBottles}</dt>
                <dd
                  className={cn('font-semibold tabular-nums', large ? 'text-2xl' : 'text-lg')}
                  data-testid={`line-bottles-${l.product.code}`}
                >
                  {l.loadedBottles} / {l.requiredBottles}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
