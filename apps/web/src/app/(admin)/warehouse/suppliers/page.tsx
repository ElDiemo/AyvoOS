import { supplierSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { buttonClass } from '@/components/ui';
import { SupplierList } from '@/components/warehouse/supplier-list';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const s = warehouseCs.suppliers;

export default async function SuppliersPage() {
  const [suppliers, me] = await Promise.all([
    apiGet('admin/suppliers', z.array(supplierSchema), { archived: 'true' }),
    currentUser(),
  ]);
  return (
    <>
      <WarehouseHeader
        active="suppliers"
        title={s.title}
        subtitle={s.subtitle}
        actions={
          hasPermission(me, 'procurement:suppliers_manage') ? (
            <Link href="/warehouse/suppliers/new" className={buttonClass.primary}>
              {s.create}
            </Link>
          ) : undefined
        }
      />
      <SupplierList suppliers={suppliers} />
    </>
  );
}
