import { inventoryMovementPageSchema, movementListQuerySchema } from '@ayvo/types';
import Link from 'next/link';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatDateTimeCs, formatDeltaCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const m = warehouseCs.movements;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const tz = await siteTimeZone();
  const raw = await searchParams;
  const parsed = movementListQuerySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : movementListQuerySchema.parse({});
  const page = await apiGet('admin/inventory/movements', inventoryMovementPageSchema, {
    page: query.page,
    pageSize: query.pageSize,
    item: query.item,
    lotId: query.lotId,
  });
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const link = (p: number) => {
    const q = new URLSearchParams({ page: String(p) });
    if (query.lotId) q.set('lotId', query.lotId);
    if (query.item) q.set('item', query.item);
    return `/warehouse/movements?${q.toString()}`;
  };
  return (
    <>
      <WarehouseHeader active="movements" title={m.title} subtitle={m.subtitle} />
      <Card className="relative overflow-x-auto p-0">
        {page.items.length === 0 ? (
          <EmptyState>{m.empty}</EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="movements">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-3 font-medium">{m.when}</th>
                <th className="px-4 py-3 font-medium">{m.type}</th>
                <th className="px-4 py-3 font-medium">{warehouseCs.receipts.item}</th>
                <th className="px-4 py-3 font-medium">{warehouseCs.receipts.lot}</th>
                <th className="px-4 py-3 text-right font-medium">{m.change}</th>
                <th className="px-4 py-3 text-right font-medium">{m.balance}</th>
                <th className="px-4 py-3 font-medium">{m.source}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {page.items.map((x) => (
                <tr key={x.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-stone-500">
                    {formatDateTimeCs(x.recordedAt, tz)}
                  </td>
                  <td className="px-4 py-2">{m.types[x.type] ?? x.type}</td>
                  <td className="px-4 py-2">{x.item.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{x.lot?.code ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatDeltaCs(x.quantityDelta)} {unitCs(x.item.unitCode)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatQuantityCs(x.balanceAfter)}
                  </td>
                  <td className="px-4 py-2">
                    {x.source.receiptCode && (
                      <Link
                        href={`/warehouse/receipts/${x.source.receiptCode}`}
                        className="font-mono hover:underline"
                      >
                        {x.source.receiptCode}
                        {x.source.receiptLineNo ? `/${x.source.receiptLineNo}` : ''}
                      </Link>
                    )}
                    {x.source.issueReason && (
                      <span className="text-stone-600">{x.source.issueReason}</span>
                    )}
                    {x.source.correctionReason && (
                      <span className="ml-2 text-stone-600">{x.source.correctionReason}</span>
                    )}
                    {x.source.bottleCode && (
                      <Link
                        href={`/bottles/${x.source.bottleCode}`}
                        className="font-mono hover:underline"
                      >
                        {x.source.bottleCode}
                      </Link>
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
            <Link href={link(query.page - 1)} className={buttonClass.secondary}>
              ←
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">
            {query.page} / {pages}
          </span>
          {query.page < pages ? (
            <Link href={link(query.page + 1)} className={buttonClass.secondary}>
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
