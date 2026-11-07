import { afterWashQueueSchema } from '@ayvo/types';
import { AfterWashWorkspace } from '@/components/returns/after-wash-workspace';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = returnsCs.afterWash;

/** Sklad → Po mytí (doc 048 §2): the second scan after washing, and the queue of the active site. */
export default async function AfterWashPage() {
  await requirePermission('returns:receive');
  const queue = await apiGet('admin/returns/after-wash', afterWashQueueSchema);
  return (
    <>
      <WarehouseHeader active="after-wash" title={t.title} subtitle={t.subtitle} />
      <AfterWashWorkspace initial={queue} />
    </>
  );
}
