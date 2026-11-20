import { pickupBoardSchema } from '@ayvo/types';
import { DispatchHeader } from '@/components/dispatch/dispatch-header';
import { PickupBoard } from '@/components/dispatch/pickup-board';
import { pickupsCs as t } from '@/i18n/cs/pickups';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Expedice → Svoz (doc 029 §11): the active site's labelled orders ready for pickup, one explicit
 * pickup order at the carrier, and the site's pickups. Ordering needs shipments:prepare.
 */
export default async function PickupsPage() {
  const [me, board] = await Promise.all([
    currentUser(),
    apiGet('admin/dispatch/pickups', pickupBoardSchema),
  ]);
  return (
    <>
      <DispatchHeader active="pickups" title={t.title} subtitle={t.subtitle} />
      <PickupBoard
        board={board}
        canOrder={hasPermission(me, 'shipments:prepare')}
        canResolve={hasPermission(me, 'shipments:resolve_uncertain')}
      />
    </>
  );
}
