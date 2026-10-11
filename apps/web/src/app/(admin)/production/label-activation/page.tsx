import {
  bottleCreationHistoryResponseSchema,
  inventoryLotSchema,
  recentLabelApplicationListSchema,
} from '@ayvo/types';
import { z } from 'zod';
import { LabelActivationStation } from '@/components/production/label-activation-station';
import { ProductionHeader } from '@/components/production/production-header';
import { productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';
import { labelReadySeries } from '@/lib/label-series';

export const dynamic = 'force-dynamic';
const t = productionCs.labelActivation;

/** Production → Nalepení etiket: the operator station of the physical label application. */
export default async function LabelActivationPage() {
  const [lots, history, recent] = await Promise.all([
    apiGet('admin/inventory/lots', z.array(inventoryLotSchema), {
      item: 'NEW_BOTTLE',
      available: 'false',
    }),
    apiGet('admin/bottle-creation-history', bottleCreationHistoryResponseSchema, {
      page: 1,
      pageSize: 100,
    }),
    apiGet('admin/label-applications', recentLabelApplicationListSchema),
  ]);
  return (
    <>
      <ProductionHeader
        active="label-activation"
        title={t.title}
        subtitle={<span className="hidden sm:inline">{t.subtitle}</span>}
      />
      <LabelActivationStation
        initialLots={lots}
        series={labelReadySeries(history.items)}
        recent={recent.items}
      />
    </>
  );
}
