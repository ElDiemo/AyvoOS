import { inventoryLotSchema, recentLabelApplicationListSchema } from '@ayvo/types';
import { z } from 'zod';
import { LabelApplicationStation } from '@/components/warehouse/label-application-station';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { warehouseCs as t } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function LabelApplicationPage() {
  const [lots, recent] = await Promise.all([
    apiGet('admin/inventory/lots', z.array(inventoryLotSchema), {
      item: 'NEW_BOTTLE',
      available: 'false',
    }),
    apiGet('admin/label-applications', recentLabelApplicationListSchema),
  ]);
  return (
    <>
      <WarehouseHeader active="labels" title={t.labels.title} subtitle={t.labels.subtitle} />
      <LabelApplicationStation initialLots={lots} recent={recent.items} />
    </>
  );
}
