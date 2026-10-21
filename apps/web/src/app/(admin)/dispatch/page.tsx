import { orderListSchema, orderViewSchema, type OrderView } from '@ayvo/types';
import Link from 'next/link';
import { DispatchHeader } from '@/components/dispatch/dispatch-header';
import { OrderRows } from '@/components/dispatch/order-rows';
import { Pager } from '@/components/dispatch/pager';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateCs } from '@/i18n/cs/format';
import { ordersCs as t } from '@/i18n/cs/orders';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const PAGE_SIZE = 50;

/**
 * Expedice → Objednávky (doc 028): the active site's orders by the requested ship day in the
 * site's time zone — Dnes, Budoucí, Po termínu (still open after the day), Dokončené a stornované.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const params = await searchParams;
  const view: OrderView = orderViewSchema.safeParse(params.view).success
    ? (params.view as OrderView)
    : 'today';
  const page = Math.max(1, Number(params.page) || 1);
  const [me, list] = await Promise.all([
    currentUser(),
    apiGet('admin/orders', orderListSchema, { view, page, pageSize: PAGE_SIZE }),
  ]);
  return (
    <>
      <DispatchHeader
        active="orders"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          hasPermission(me, 'orders:manage') && (
            <Link href="/dispatch/orders/new" className={buttonClass.primary}>
              {t.newOrder}
            </Link>
          )
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t.title} data-testid="order-views">
        {orderViewSchema.options.map((v) => (
          <Link
            key={v}
            href={`/dispatch?view=${v}`}
            data-testid={`order-view-${v}`}
            aria-current={view === v ? 'page' : undefined}
            className={
              view === v
                ? 'rounded-full border border-stone-900 bg-stone-900 px-3 py-1 text-sm text-white'
                : v === 'overdue' && list.counts.overdue > 0
                  ? 'rounded-full border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-900 hover:border-red-500'
                  : 'rounded-full border border-stone-300 bg-white px-3 py-1 text-sm text-stone-800 hover:border-stone-500'
            }
          >
            {t.views[v]} ({list.counts[v]})
          </Link>
        ))}
      </nav>
      <p className="mb-2 text-xs text-stone-500" data-testid="orders-today">
        {t.views.today}: {formatDateCs(list.today)}
      </p>
      <Card>
        {list.items.length === 0 ? (
          <EmptyState>{t.empty[view]}</EmptyState>
        ) : (
          <OrderRows orders={list.items} today={list.today} />
        )}
      </Card>
      <Pager
        page={list.page}
        pageSize={list.pageSize}
        total={list.total}
        href={(p) => `/dispatch?view=${view}&page=${p}`}
      />
    </>
  );
}
