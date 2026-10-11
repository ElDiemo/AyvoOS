import { supplierSchema } from '@ayvo/types';
import { z } from 'zod';
import { Card, EmptyState } from '@/components/ui';
import { ArchiveSupplierButton, SupplierForm } from '@/components/warehouse/supplier-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const s = warehouseCs.suppliers;

export default async function SuppliersPage() {
  const suppliers = await apiGet('admin/suppliers', z.array(supplierSchema), { archived: 'true' });
  return (
    <>
      <WarehouseHeader active="suppliers" title={s.title} subtitle={s.subtitle} />
      <div className="flex flex-col gap-6">
        <Card title={s.create}>
          <SupplierForm />
        </Card>
        <Card className="relative overflow-x-auto p-0">
          {suppliers.length === 0 ? (
            <EmptyState>{s.empty}</EmptyState>
          ) : (
            <table className="w-full text-left text-sm" data-testid="suppliers">
              <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-6 py-3 font-medium">{s.name}</th>
                  <th className="px-6 py-3 font-medium">{s.companyId}</th>
                  <th className="px-6 py-3 font-medium">{s.vatId}</th>
                  <th className="px-6 py-3 font-medium">
                    <span className="sr-only">{s.archive}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {suppliers.map((x) => (
                  <tr key={x.id} className={x.archivedAt ? 'text-stone-400' : ''}>
                    <td className="px-6 py-3 wrap-anywhere">{x.name}</td>
                    <td className="px-6 py-3">{x.companyId ?? '—'}</td>
                    <td className="px-6 py-3">{x.vatId ?? '—'}</td>
                    <td className="px-6 py-3 text-right">
                      {x.archivedAt ? s.archived : <ArchiveSupplierButton id={x.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
