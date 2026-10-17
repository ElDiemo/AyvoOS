import { currentStationSessionSchema, managedWorkstationSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { ProductionHeader } from '@/components/production/production-header';
import { buttonClass, Notice } from '@/components/ui';
import { StationPanel } from '@/components/workstations/station-panel';
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiGet } from '@/lib/api';
import { hasPermission, requireAnyPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = workstationsCs.station;

/** Výroba → Pracoviště (doc 026): the station the user works at, opened by scanning its QR. */
export default async function StationPage() {
  const me = await requireAnyPermission(['production:fill', 'production:label_apply']);
  const manages = hasPermission(me, 'production:workstations_manage');
  const [initial, timeZone, stations] = await Promise.all([
    apiGet('admin/station-sessions/current', currentStationSessionSchema),
    siteTimeZone(),
    // Only a station manager may list them; everyone else gets the general hint below.
    manages ? apiGet('admin/workstations', z.array(managedWorkstationSchema)) : null,
  ]);
  const free = !initial.current && !initial.blocked;
  const noStation = stations !== null && !stations.some((w) => w.status === 'ACTIVE');
  return (
    <>
      <ProductionHeader active="station" title={t.title} subtitle={t.subtitle} />
      {free && noStation && (
        <div className="mb-4 flex flex-col gap-2" data-testid="station-none">
          <Notice tone="warning">{t.noStation}</Notice>
          <Link href="/production/workstations" className={`${buttonClass.primary} self-start`}>
            {t.createStation}
          </Link>
        </div>
      )}
      {free && !manages && (
        <p className="mb-4 text-sm text-stone-600" data-testid="station-hint">
          {t.askForStation}
        </p>
      )}
      <StationPanel
        initial={initial}
        canTakeover={hasPermission(me, 'production:session_takeover')}
        timeZone={timeZone}
      />
    </>
  );
}
