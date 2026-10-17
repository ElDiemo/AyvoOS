import type { OrderSummary } from '@ayvo/types';
import Link from 'next/link';
import { RowValue } from '@/components/catalog/catalog-header';
import { formatDateCs } from '@/i18n/cs/format';
import { ordersCs as t } from '@/i18n/cs/orders';
import { OrderStatusBadge } from './order-status';

/** Orders as rows: number, hotel, ship day, state and loaded / required crates and bottles. */
export function OrderRows({ orders, hotel = true }: { orders: OrderSummary[]; hotel?: boolean }) {
  const grid = 'md:grid-cols-[7rem_minmax(0,1.4fr)_7rem_minmax(0,1fr)_7rem_7rem]';
  return (
    <>
      <div
        className={`hidden gap-x-4 border-b border-stone-200 pb-2 text-xs font-medium text-stone-500 md:grid ${grid}`}
        data-testid="order-columns"
      >
        <span>{t.columns.code}</span>
        <span>{hotel ? t.columns.hotel : t.detail.site}</span>
        <span>{t.columns.shipDate}</span>
        <span>{t.columns.status}</span>
        <span>{t.columns.cratesOf}</span>
        <span>{t.columns.bottlesOf}</span>
      </div>
      <ul data-testid="orders">
        {orders.map((o) => (
          <li
            key={o.code}
            data-testid={`order-${o.code}`}
            className={`grid grid-cols-1 gap-x-4 gap-y-1 border-t border-stone-100 py-3 text-sm first:border-t-0 md:items-center ${grid}`}
          >
            <Link
              href={`/dispatch/orders/${o.code}`}
              className="font-mono font-medium underline-offset-2 hover:underline"
            >
              {o.code}
            </Link>
            <RowValue label={hotel ? t.columns.hotel : t.detail.site}>
              {hotel ? o.hotel.name : o.site.name}
            </RowValue>
            <RowValue label={t.columns.shipDate}>{formatDateCs(o.requestedShipDate)}</RowValue>
            <RowValue label={t.columns.status}>
              <OrderStatusBadge order={o} />
            </RowValue>
            <RowValue label={t.columns.cratesOf}>
              <span className="tabular-nums">
                {t.of(o.totals.loadedCrates, o.totals.requiredCrates)}
              </span>
            </RowValue>
            <RowValue label={t.columns.bottlesOf}>
              <span className="tabular-nums">
                {t.of(o.totals.loadedBottles, o.totals.requiredBottles)}
              </span>
            </RowValue>
          </li>
        ))}
      </ul>
    </>
  );
}
