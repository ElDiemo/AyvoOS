import {
  goodsReceiptPageSchema,
  inventoryMovementPageSchema,
  stockOverviewSchema,
  supplierSchema,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import { buttonClass, Card, CardLink, EmptyState, Notice } from '@/components/ui';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatDateTimeCs, formatDeltaCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const o = warehouseCs.overview;
const th = 'py-2 pr-4 font-medium';

/**
 * Sklad → Přehled skladu (doc 019): current stock, what needs attention, recent receipts and
 * movements, and the next useful action. Read-only; every figure comes from the API.
 */
export default async function WarehouseOverviewPage() {
  const [stock, receipts, pending, movements, suppliers] = await Promise.all([
    apiGet('admin/inventory/stock', stockOverviewSchema),
    apiGet('admin/goods-receipts', goodsReceiptPageSchema, { page: 1, pageSize: 5 }),
    apiGet('admin/goods-receipts', goodsReceiptPageSchema, {
      page: 1,
      pageSize: 1,
      invoice: 'pending',
    }),
    apiGet('admin/inventory/movements', inventoryMovementPageSchema, { page: 1, pageSize: 8 }),
    apiGet('admin/suppliers', z.array(supplierSchema)),
  ]);
  const activeSuppliers = suppliers.filter((s) => !s.archivedAt).length;

  const attention: { key: string; text: React.ReactNode }[] = [];
  if (activeSuppliers === 0) attention.push({ key: 'suppliers', text: o.noSuppliers });
  for (const entry of stock.items) {
    if (entry.lowStock)
      attention.push({ key: `low-${entry.item.code}`, text: o.lowStock(entry.item.name) });
    else if (entry.onHand === '0')
      attention.push({ key: `empty-${entry.item.code}`, text: o.noStock(entry.item.name) });
  }
  if (pending.total > 0) {
    attention.push({
      key: 'invoices',
      text: (
        <Link href="/warehouse/receipts?invoice=pending" className="underline">
          {o.pendingInvoices(pending.total)}
        </Link>
      ),
    });
  }

  const next =
    activeSuppliers === 0
      ? { href: '/warehouse/suppliers', label: o.createSupplier }
      : receipts.total === 0
        ? { href: '/warehouse/receipts/new', label: o.firstReceipt }
        : { href: '/warehouse/receipts/new', label: o.newReceipt };

  return (
    <>
      <WarehouseHeader
        active="overview"
        title={o.title}
        subtitle={o.subtitle}
        actions={
          <Link href={next.href} className={buttonClass.primary} data-testid="next-action">
            {next.label}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card
            title={`${o.stock} – ${stock.location.name}`}
            className="relative overflow-x-auto"
            action={<CardLink href="/warehouse/stock">{warehouseCs.tabs.stock}</CardLink>}
          >
            <table className="w-full text-left text-sm" data-testid="overview-stock">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className={th}>{o.item}</th>
                  <th className={cn(th, 'text-right')}>{warehouseCs.stock.onHand}</th>
                  <th className={cn(th, 'text-right')}>{warehouseCs.stock.available}</th>
                  <th className={cn(th, 'pr-0')}>{o.lots}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {stock.items.map((entry) => (
                  <tr key={entry.item.id} data-testid={`overview-stock-${entry.item.code}`}>
                    <td className="py-2 pr-4 align-top">
                      <span className="font-medium">{entry.item.name}</span>
                      <span className="block font-mono text-xs text-stone-500">
                        {entry.item.code}
                      </span>
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-4 text-right align-top text-lg font-semibold tabular-nums',
                        entry.lowStock && 'text-red-800',
                      )}
                    >
                      {formatQuantityCs(entry.onHand)}{' '}
                      <span className="text-xs font-normal text-stone-500">
                        {unitCs(entry.item.unit.code)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right align-top tabular-nums">
                      {formatQuantityCs(entry.available)}
                    </td>
                    <td className="py-2 align-top text-stone-600">
                      {entry.lots.length === 0 ? (
                        warehouseCs.stock.noLots
                      ) : (
                        <>
                          {o.lotsCount(entry.lots.length)}
                          <span className="block font-mono text-xs wrap-anywhere text-stone-500">
                            {entry.lots
                              .slice(0, 3)
                              .map((l) => `${l.code} (${formatQuantityCs(l.onHand)})`)
                              .join(', ')}
                            {entry.lots.length > 3 ? ' …' : ''}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title={o.attention} testId="attention">
            {attention.length === 0 ? (
              <p className="text-sm text-stone-500">{o.nothing}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Notice>{a.text}</Notice>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card
            title={o.recentReceipts}
            className="relative overflow-x-auto"
            action={<CardLink href="/warehouse/receipts">{o.showAll}</CardLink>}
          >
            {receipts.items.length === 0 ? (
              <EmptyState>{o.noReceipts}</EmptyState>
            ) : (
              <table className="w-full text-left text-sm" data-testid="overview-receipts">
                <tbody className="divide-y divide-stone-100">
                  {receipts.items.map((x) => (
                    <tr key={x.code}>
                      <td className="py-2 pr-4 align-top">
                        <Link
                          href={`/warehouse/receipts/${x.code}`}
                          className="font-mono font-medium hover:underline"
                        >
                          {x.code}
                        </Link>
                        <span className="block text-xs text-stone-500">
                          {formatDateTimeCs(x.receivedAt)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top wrap-anywhere">
                        {x.supplier.name}
                        <span className="block text-xs text-stone-500">{x.supplierReference}</span>
                      </td>
                      <td className="py-2 text-right align-top">
                        {x.invoicePending ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs whitespace-nowrap text-amber-900">
                            {warehouseCs.receipts.invoicePending}
                          </span>
                        ) : (
                          <span className="text-xs whitespace-nowrap text-stone-500">
                            {warehouseCs.receipts.invoiceComplete}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title={o.recentMovements}
            className="relative overflow-x-auto"
            action={<CardLink href="/warehouse/movements">{o.showAll}</CardLink>}
          >
            {movements.items.length === 0 ? (
              <EmptyState>{o.noMovements}</EmptyState>
            ) : (
              <table className="w-full text-left text-sm" data-testid="overview-movements">
                <tbody className="divide-y divide-stone-100">
                  {movements.items.map((x) => (
                    <tr key={x.id}>
                      <td className="py-2 pr-4 align-top">
                        {warehouseCs.movements.types[x.type] ?? x.type}
                        <span className="block text-xs text-stone-500">
                          {formatDateTimeCs(x.recordedAt)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top wrap-anywhere">
                        {x.item.name}
                        <span className="block font-mono text-xs text-stone-500">
                          {x.lot?.code ?? '—'}
                          {x.source.bottleCode ? ` · ${x.source.bottleCode}` : ''}
                        </span>
                      </td>
                      <td className="py-2 text-right align-top font-medium whitespace-nowrap tabular-nums">
                        {formatDeltaCs(x.quantityDelta)} {unitCs(x.item.unitCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
