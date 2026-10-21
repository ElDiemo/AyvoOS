import { supplierDetailSchema } from '@ayvo/types';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { SupplierEditor } from '@/components/warehouse/supplier-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const s = warehouseCs.suppliers;

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await requirePermission('procurement:suppliers_edit');
  const supplier = await apiGet(`admin/suppliers/${id}`, supplierDetailSchema);
  if (supplier.archivedAt) redirect(`/warehouse/suppliers/${id}`);
  return (
    <>
      <WarehouseHeader
        active="suppliers"
        title={`${s.editTitle}: ${supplier.name}`}
        back={{ href: `/warehouse/suppliers/${id}`, label: supplier.name }}
      />
      <SupplierEditor supplier={supplier} />
    </>
  );
}
