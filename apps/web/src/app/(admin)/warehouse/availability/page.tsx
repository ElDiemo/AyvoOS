import { stockSummarySchema } from '@ayvo/types';
import { Card } from '@/components/ui';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const a = warehouseCs.availability;

/**
 * Stock availability for planning (SALES, doc 021): read-only and limited by the API to item,
 * available, reserved and the low-stock flag.
 */
export default async function AvailabilityPage() {
  const summary = await apiGet('admin/inventory/stock-summary', stockSummarySchema);
  return (
    <>
      <WarehouseHeader
        active="availability"
        title={`${a.title} – ${summary.location.name}`}
        subtitle={a.subtitle}
      />
      <Card>
        {summary.items.length === 0 ? (
          <p className="text-sm text-stone-500">{a.empty}</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="availability">
              <thead className="text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">{a.item}</th>
                  <th className="py-2 pr-4 text-right font-medium">{a.available}</th>
                  <th className="py-2 pr-4 text-right font-medium">{a.reserved}</th>
                  <th className="py-2 font-medium">{a.state}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {summary.items.map((row) => {
                  const unit = unitCs(row.item.unitCode);
                  return (
                    <tr key={row.item.code} data-testid={`availability-${row.item.code}`}>
                      <td className="py-2 pr-4">
                        {row.item.name}{' '}
                        <span className="font-mono text-xs text-stone-500">{row.item.code}</span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatQuantityCs(row.available)} {unit}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatQuantityCs(row.reserved)} {unit}
                      </td>
                      <td className="py-2">
                        {row.lowStock ? (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                            {a.lowStock}
                          </span>
                        ) : (
                          <span className="text-xs text-stone-600">{a.ok}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
