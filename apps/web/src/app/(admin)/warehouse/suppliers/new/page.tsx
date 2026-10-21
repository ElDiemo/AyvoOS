import { SupplierEditor } from '@/components/warehouse/supplier-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const s = warehouseCs.suppliers;

export default async function NewSupplierPage() {
  await requirePermission('procurement:suppliers_manage');
  return (
    <>
      <WarehouseHeader
        active="suppliers"
        title={s.createTitle}
        subtitle={s.createSubtitle}
        back={{ href: '/warehouse/suppliers', label: s.back }}
      />
      <SupplierEditor supplier={null} />
    </>
  );
}
