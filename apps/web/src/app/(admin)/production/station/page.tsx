import { currentStationSessionSchema } from '@ayvo/types';
import { ProductionHeader } from '@/components/production/production-header';
import { StationPanel } from '@/components/workstations/station-panel';
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiGet } from '@/lib/api';
import { hasPermission, requireAnyPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = workstationsCs.station;

/** Výroba → Pracoviště (doc 026): the station the user works at, opened by scanning its QR. */
export default async function StationPage() {
  const me = await requireAnyPermission(['production:fill', 'production:label_apply']);
  const [initial, timeZone] = await Promise.all([
    apiGet('admin/station-sessions/current', currentStationSessionSchema),
    siteTimeZone(),
  ]);
  return (
    <>
      <ProductionHeader active="station" title={t.title} subtitle={t.subtitle} />
      <StationPanel
        initial={initial}
        canTakeover={hasPermission(me, 'production:session_takeover')}
        timeZone={timeZone}
      />
    </>
  );
}
