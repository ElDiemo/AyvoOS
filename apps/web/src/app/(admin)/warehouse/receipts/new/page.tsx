import { inventoryItemSchema, supplierSchema } from '@ayvo/types';
import { z } from 'zod';
import { GoodsReceiptForm } from '@/components/warehouse/goods-receipt-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewReceiptPage() {
  const [suppliers, items] = await Promise.all([
    apiGet('admin/suppliers', z.array(supplierSchema)),
    apiGet('admin/inventory/items', z.array(inventoryItemSchema)),
  ]);
  return (
    <>
      <WarehouseHeader
        active="new-receipt"
        title={warehouseCs.receipts.newTitle}
        subtitle={warehouseCs.receipts.newSubtitle}
      />
      <GoodsReceiptForm suppliers={suppliers} items={items} />
    </>
  );
}
