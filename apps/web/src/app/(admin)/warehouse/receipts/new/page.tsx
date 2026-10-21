import { inventoryItemSchema, supplierSchema } from '@ayvo/types';
import { z } from 'zod';
import { Notice } from '@/components/ui';
import { GoodsReceiptForm } from '@/components/warehouse/goods-receipt-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';
import { setupReturn } from '@/lib/setup-return';

export const dynamic = 'force-dynamic';

/**
 * Příjem zboží. From "Připravit výrobu" (issue #11 UI-21) the item of the judged recipe line is
 * preselected and the page leads back to the same product; quantity, supplier and lot are never
 * filled in. An unknown item is not replaced by another one — the user chooses.
 */
export default async function NewReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; back?: string }>;
}) {
  const params = await searchParams;
  const [suppliers, items, me] = await Promise.all([
    apiGet('admin/suppliers', z.array(supplierSchema)),
    apiGet('admin/inventory/items', z.array(inventoryItemSchema)),
    currentUser(),
  ]);
  const r = warehouseCs.receipts;
  const back = setupReturn(params.back);
  const wanted = typeof params.item === 'string' && params.item ? params.item : null;
  const item = wanted ? (items.find((i) => i.code === wanted) ?? null) : null;
  return (
    <>
      <WarehouseHeader
        active="new-receipt"
        title={r.newTitle}
        subtitle={r.newSubtitle}
        back={back ? { href: back, label: r.backToSetup } : undefined}
      />
      {wanted && (
        <div className="mb-4" data-testid="receipt-context">
          <Notice tone={item ? 'info' : 'warning'}>
            {item ? r.forSetup(`${item.name} (${item.code})`) : r.unknownSetupItem(wanted)}
          </Notice>
        </div>
      )}
      <GoodsReceiptForm
        suppliers={suppliers}
        items={items}
        canWriteCosts={hasPermission(me, 'procurement:cost_write')}
        canManageBarcodes={hasPermission(me, 'inventory:barcodes_manage')}
        initialItemId={wanted ? (item?.id ?? null) : undefined}
      />
    </>
  );
}
