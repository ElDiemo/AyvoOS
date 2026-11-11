import Link from 'next/link';
import { AfterWashCounts } from '@/components/returns/after-wash-counts';
import { CycleHeader } from '@/components/returns/cycle-header';
import { buttonClass, Card } from '@/components/ui';
import { returnsCs } from '@/i18n/cs/returns';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const c = returnsCs.cycle;

/**
 * Výroba → Oběh lahví (owner 2026-11-09): the two actions of the returned bottles of the active
 * site — Příjem vratek (scan the return) and Po mytí (confirm the washed bottle) — and the link to
 * the station for those who may work there. Only existing screens and reads; no new step. The Po
 * mytí counts are their own panel: when they fail, both actions stay (review 5841814857).
 */
export default async function BottleCyclePage() {
  const me = await requirePermission('returns:receive');
  const site = me.sites.find((s) => s.id === me.activeSiteId);
  const station =
    hasPermission(me, 'production:label_apply') || hasPermission(me, 'production:fill');
  return (
    <>
      <CycleHeader active="overview" title={c.title} subtitle={c.subtitle} />
      {site && (
        <p className="mb-4 text-sm text-stone-600" data-testid="cycle-site">
          {c.site(`${site.code} · ${site.name}`)}
        </p>
      )}
      <ol className="grid gap-4 lg:grid-cols-3" data-testid="cycle-steps">
        <li className="min-w-0">
          <Card title={`${c.step(1)} · ${c.view.returns}`} className="h-full">
            <p className="mb-4 text-sm text-stone-600">{c.returns.text}</p>
            <Link
              href="/production/cycle/returns"
              className={buttonClass.primary}
              data-testid="cycle-returns"
            >
              {c.returns.open}
            </Link>
          </Card>
        </li>
        <li className="min-w-0">
          <Card title={`${c.step(2)} · ${c.view.afterWash}`} className="h-full">
            <p className="mb-4 text-sm text-stone-600">{c.afterWash.text}</p>
            <AfterWashCounts />
            <Link
              href="/production/cycle/after-wash"
              className={buttonClass.primary}
              data-testid="cycle-after-wash"
            >
              {c.afterWash.open}
            </Link>
            <p className="mt-3 text-xs text-stone-500">{returnsCs.afterWash.readyHint}</p>
          </Card>
        </li>
        {station && (
          <li className="min-w-0">
            <Card title={c.station.title} className="h-full">
              <p className="mb-4 text-sm text-stone-600">{c.station.text}</p>
              <Link
                href="/production/station"
                className={buttonClass.secondary}
                data-testid="cycle-station"
              >
                {c.station.open}
              </Link>
            </Card>
          </li>
        )}
      </ol>
    </>
  );
}
