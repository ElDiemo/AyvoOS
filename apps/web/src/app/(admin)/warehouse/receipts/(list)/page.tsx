import { goodsReceiptListQuerySchema, goodsReceiptPageSchema } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const r = warehouseCs.receipts;

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const tz = await siteTimeZone();
  const parsed = goodsReceiptListQuerySchema.safeParse(await searchParams);
  const query = parsed.success ? parsed.data : goodsReceiptListQuerySchema.parse({});
  const list = await apiGet('admin/goods-receipts', goodsReceiptPageSchema, {
    page: query.page,
    pageSize: query.pageSize,
    invoice: query.invoice,
  });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filter = (invoice: 'any' | 'pending', label: string) => (
    <Link
      href={invoice === 'pending' ? '/warehouse/receipts?invoice=pending' : '/warehouse/receipts'}
      aria-current={query.invoice === invoice ? 'page' : undefined}
      className={cn(
        'rounded-full px-3 py-1 text-sm',
        query.invoice === invoice ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-700',
      )}
    >
      {label}
    </Link>
  );
  return (
    <>
      <WarehouseHeader active="receipts" title={r.title} subtitle={r.subtitle} />
      <div className="mb-4 flex gap-2">
        {filter('any', r.filterAll)}
        {filter('pending', r.filterInvoicePending)}
      </div>
      <Card className="relative overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>{query.invoice === 'pending' ? r.emptyFiltered : r.empty}</EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="receipts">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">{r.code}</th>
                <th className="px-6 py-3 font-medium">{r.supplier}</th>
                <th className="px-6 py-3 font-medium">{r.reference}</th>
                <th className="px-6 py-3 font-medium">{r.receivedAt}</th>
                <th className="px-6 py-3 font-medium">{r.lines}</th>
                <th className="px-6 py-3 font-medium">{r.documents}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.items.map((x) => (
                <tr key={x.code} className="hover:bg-stone-50">
                  <td className="px-6 py-3 font-mono">
                    <Link
                      href={`/warehouse/receipts/${x.code}`}
                      className="font-medium hover:underline"
                    >
                      {x.code}
                    </Link>
                  </td>
                  <td className="px-6 py-3">{x.supplier.name}</td>
                  <td className="px-6 py-3">{x.supplierReference}</td>
                  <td className="whitespace-nowrap px-6 py-3 text-stone-500">
                    {formatDateTimeCs(x.receivedAt, tz)}
                  </td>
                  <td className="px-6 py-3 tabular-nums">{x.lineCount}</td>
                  <td className="px-6 py-3">
                    {x.invoicePending ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                        {r.invoicePending}
                      </span>
                    ) : (
                      <span className="text-xs text-stone-500">{r.invoiceComplete}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm" aria-label="Stránkování">
          {query.page > 1 ? (
            <Link
              href={`/warehouse/receipts?page=${query.page - 1}&invoice=${query.invoice}`}
              className={buttonClass.secondary}
            >
              ←
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">
            {query.page} / {pages}
          </span>
          {query.page < pages ? (
            <Link
              href={`/warehouse/receipts?page=${query.page + 1}&invoice=${query.invoice}`}
              className={buttonClass.secondary}
            >
              →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
