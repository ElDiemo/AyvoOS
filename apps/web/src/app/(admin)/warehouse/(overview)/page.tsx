import {
  goodsReceiptPageSchema,
  stockOverviewSchema,
  stockSummarySchema,
  supplierSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { buttonClass, Card, CardLink, Notice } from '@/components/ui';
import { StockList } from '@/components/warehouse/stock-list';
import { stockState } from '@/components/warehouse/stock-state';
import { StockSummaryList } from '@/components/warehouse/stock-summary-list';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const i = warehouseCs.inventory;
const o = warehouseCs.overview;

/**
 * Sklad → Zásoby (owner 2026-11-16): one list of the active site's items. With inventory:read the
 * warehouse's view (stock, lots, issue, planning); with inventory:stock_summary only the planning
 * view, read from the limited stock-summary contract alone — nothing else is fetched for it.
 */
export default async function WarehouseStockPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string }>;
}) {
  const me = await currentUser();
  if (!hasPermission(me, 'inventory:read')) {
    const summary = await apiGet('admin/inventory/stock-summary', stockSummarySchema);
    return (
      <>
        <WarehouseHeader
          active="overview"
          title={`${i.title} – ${summary.location.name}`}
          subtitle={i.summarySubtitle}
        />
        <Card>
          <StockSummaryList summary={summary} />
        </Card>
      </>
    );
  }

  const { item } = await searchParams;
  const tz = await siteTimeZone();
  const [stock, pending, suppliers] = await Promise.all([
    apiGet('admin/inventory/stock', stockOverviewSchema),
    apiGet('admin/goods-receipts', goodsReceiptPageSchema, {
      page: 1,
      pageSize: 1,
      invoice: 'pending',
    }),
    apiGet('admin/suppliers', z.array(supplierSchema)),
  ]);
  const canReceive = hasPermission(me, 'inventory:receive');
  const names = (state: 'none' | 'low') =>
    stock.items
      .filter((e) => stockState(e.available, e.lowStock) === state)
      .map((e) => e.item.name)
      .join(', ');
  const attention: { key: string; text: React.ReactNode }[] = [];
  if (!suppliers.some((s) => !s.archivedAt))
    attention.push({
      key: 'suppliers',
      text: (
        <Link href="/warehouse/suppliers" className="underline">
          {o.noSuppliers}
        </Link>
      ),
    });
  if (names('none')) attention.push({ key: 'none', text: i.noneAvailable(names('none')) });
  if (names('low')) attention.push({ key: 'low', text: i.belowMinimum(names('low')) });
  if (pending.total > 0)
    attention.push({
      key: 'invoices',
      text: (
        <Link href="/warehouse/receipts?invoice=pending" className="underline">
          {o.pendingInvoices(pending.total)}
        </Link>
      ),
    });

  return (
    <>
      <WarehouseHeader
        active="overview"
        title={`${i.title} – ${stock.location.name}`}
        subtitle={i.subtitle}
        actions={
          canReceive ? (
            <Link
              href="/warehouse/receipts/new"
              className={buttonClass.primary}
              data-testid="receive-goods"
            >
              {i.receive}
            </Link>
          ) : null
        }
      />
      <div className="flex flex-col gap-6">
        {attention.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="attention">
            {attention.map((a) => (
              <li key={a.key}>
                <Notice>{a.text}</Notice>
              </li>
            ))}
          </ul>
        )}
        <Card
          title={i.title}
          action={
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              <CardLink href="/warehouse/receipts">{i.allReceipts}</CardLink>
              <CardLink href="/warehouse/movements">{i.allMovements}</CardLink>
            </span>
          }
        >
          <StockList
            items={stock.items}
            suppliers={suppliers}
            tz={tz}
            canIssue={hasPermission(me, 'inventory:consume')}
            canPlan={hasPermission(me, 'inventory:items_manage')}
            open={item}
          />
        </Card>
      </div>
    </>
  );
}
