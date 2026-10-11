import { stockOverviewSchema, supplierSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { Card, Field, FieldList } from '@/components/ui';
import { ItemSettingsForm } from '@/components/warehouse/item-settings-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatDateTimeCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const s = warehouseCs.stock;

export default async function StockPage() {
  const [stock, suppliers] = await Promise.all([
    apiGet('admin/inventory/stock', stockOverviewSchema),
    apiGet('admin/suppliers', z.array(supplierSchema)),
  ]);
  return (
    <>
      <WarehouseHeader
        active="stock"
        title={`${s.title} – ${stock.location.name}`}
        subtitle={s.subtitle}
      />
      <div className="flex flex-col gap-6">
        {stock.items.map((entry) => {
          const unit = unitCs(entry.item.unit.code);
          return (
            <Card key={entry.item.id}>
              <div data-testid={`stock-${entry.item.code}`}>
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold">
                    {entry.item.name}{' '}
                    <span className="font-mono text-xs text-stone-500">{entry.item.code}</span>
                  </h2>
                  {entry.lowStock && (
                    <span
                      className="rounded-full bg-red-100 px-3 py-1 text-sm font-medium text-red-900"
                      data-testid="low-stock"
                    >
                      {s.lowStock}
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    [s.onHand, entry.onHand],
                    [s.reserved, entry.reserved],
                    [s.available, entry.available],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
                      <dd className="text-2xl font-semibold tabular-nums">
                        {formatQuantityCs(value!)}{' '}
                        <span className="text-sm font-normal">{unit}</span>
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-stone-500">{s.onOrder}</dt>
                    <dd className="text-sm text-stone-500">
                      {entry.onOrder ?? warehouseCs.common.notTracked}
                    </dd>
                  </div>
                </dl>
                {entry.suggestedQuantity && (
                  <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    {s.suggestion(formatQuantityCs(entry.suggestedQuantity), unit)}
                  </p>
                )}
                {entry.item.lotTracked && (
                  <>
                    <h3 className="mt-6 mb-2 text-sm font-medium">{s.lots}</h3>
                    {entry.lots.length === 0 ? (
                      <p className="text-sm text-stone-500">{s.noLots}</p>
                    ) : (
                      <div className="relative overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <tbody className="divide-y divide-stone-100">
                            {entry.lots.map((lot) => (
                              <tr key={lot.id}>
                                <td className="py-2 pr-4 font-mono">
                                  <Link
                                    href={`/warehouse/movements?lotId=${lot.id}`}
                                    className="hover:underline"
                                  >
                                    {lot.code}
                                  </Link>
                                </td>
                                <td className="py-2 pr-4 text-stone-600">
                                  {s.lotKind[lot.kind]}
                                  {lot.supplier ? ` · ${lot.supplier.name}` : ''}
                                </td>
                                <td className="whitespace-nowrap py-2 pr-4 text-stone-500">
                                  {formatDateTimeCs(lot.createdAt)}
                                </td>
                                <td className="py-2 text-right font-semibold tabular-nums">
                                  {formatQuantityCs(lot.onHand)} {unit}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
                <details className="mt-6">
                  <summary className="cursor-pointer text-sm font-medium">{s.settings}</summary>
                  <div className="mt-3">
                    {entry.item.settings ? (
                      <FieldList>
                        <Field label={s.reorderPoint}>
                          {entry.item.settings.reorderPoint ?? '—'}
                        </Field>
                        <Field label={s.targetLevel}>
                          {entry.item.settings.targetLevel ?? '—'}
                        </Field>
                      </FieldList>
                    ) : (
                      <p className="mb-3 text-sm text-stone-500">{s.noSettings}</p>
                    )}
                    <div className="mt-3">
                      <ItemSettingsForm item={entry.item} suppliers={suppliers} />
                    </div>
                  </div>
                </details>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
