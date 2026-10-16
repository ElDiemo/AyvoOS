import {
  bottleCreationHistoryResponseSchema,
  cratePageSchema,
  bottleListResponseSchema,
  labelTemplateSummarySchema,
  recentLabelApplicationListSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { ProductionHeader } from '@/components/production/production-header';
import { PrintJobStatus } from '@/components/status';
import { buttonClass, Card, CardLink, EmptyState, Stat } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { bottlesWord, productionCs } from '@/i18n/cs/production';
import { shellCs } from '@/i18n/cs/shell';
import { apiGet } from '@/lib/api';
import { codeRange } from '@/lib/format';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const o = productionCs.overview;
const pages = shellCs.modules.production.pages;

const count = (status?: 'CREATED' | 'LABELED_EMPTY') =>
  apiGet('admin/bottles', bottleListResponseSchema, { page: 1, pageSize: 1, status }).then(
    (r) => r.total,
  );

/** Výroba → Přehled výroby: what production has, what is waiting, what happened last. */
export default async function ProductionOverviewPage() {
  const me = await currentUser();
  const crates = hasPermission(me, 'crates:read')
    ? await apiGet('admin/crates', cratePageSchema, { page: 1, pageSize: 1 })
    : null;
  const [total, awaiting, labeled, history, templates, recent] = await Promise.all([
    count(),
    count('CREATED'),
    count('LABELED_EMPTY'),
    apiGet('admin/bottle-creation-history', bottleCreationHistoryResponseSchema, {
      page: 1,
      pageSize: 6,
    }),
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
    apiGet('admin/label-applications', recentLabelApplicationListSchema),
  ]);
  const activeTemplates = templates.filter((t) => !t.archivedAt).length;

  return (
    <>
      <ProductionHeader
        active="overview"
        title={o.title}
        subtitle={o.subtitle}
        actions={
          // The work entry is the prominent button of the module navigation (doc 027).
          hasPermission(me, 'production:bottles_create') ? (
            <Link href="/bottles/new" className={buttonClass.secondary}>
              {shellCs.actions.createBottles}
            </Link>
          ) : null
        }
      />
      <div className="flex flex-col gap-6">
        {crates && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="production-crates">
            {(['OPEN_ASSEMBLY', 'READY_TO_FILL', 'FILLING', 'FILLED'] as const).map((state) => (
              <Stat
                key={state}
                label={`${o.crates}: ${cratesCs.state[state]}`}
                value={crates.stateCounts[state] ?? 0}
                href={`/production/crates?state=${state}`}
                testId={`stat-crates-${state}`}
              />
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="production-stats">
          <Stat label={o.bottles} value={total} href="/bottles" testId="stat-bottles" />
          <Stat
            label={o.awaitingLabel}
            value={awaiting}
            href="/bottles?status=CREATED"
            testId="stat-awaiting-label"
          />
          <Stat
            label={o.labeled}
            value={labeled}
            href="/bottles?status=LABELED_EMPTY"
            testId="stat-labeled"
          />
          <Stat
            label={o.templates}
            value={activeTemplates}
            href="/label-templates"
            testId="stat-templates"
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card
            title={o.recentSeries}
            className="relative overflow-x-auto"
            action={<CardLink href="/bottles/history">{productionCs.bottles.history}</CardLink>}
          >
            {history.items.length === 0 ? (
              <EmptyState>
                {o.noSeries}{' '}
                <Link href="/bottles/new" className="font-medium underline">
                  {shellCs.actions.createBottles}
                </Link>
              </EmptyState>
            ) : (
              <table className="w-full text-left text-sm" data-testid="recent-series">
                <thead className="text-xs text-stone-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">{productionCs.bottles.series}</th>
                    <th className="py-2 pr-4 font-medium">{productionCs.bottles.bottlesColumn}</th>
                    <th className="py-2 pr-4 font-medium">{productionCs.bottles.template}</th>
                    <th className="py-2 font-medium">{productionCs.bottles.labelsColumn}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {history.items.map((s) => (
                    <tr key={s.code}>
                      <td className="py-2 pr-4 align-top">
                        <Link
                          href={`/batches/${s.code}`}
                          className="font-mono font-medium hover:underline"
                        >
                          {s.code}
                        </Link>
                        <span className="block text-xs text-stone-500">
                          {formatDateTimeCs(s.createdAt)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top">
                        {bottlesWord(s.quantityCreated)}
                        <span className="block font-mono text-xs text-stone-500">
                          {codeRange(s.firstBottleCode, s.lastBottleCode)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top wrap-anywhere">{s.labelTemplate.label}</td>
                      <td className="py-2 align-top">
                        {s.latestPrintJob ? (
                          <PrintJobStatus status={s.latestPrintJob.status} />
                        ) : (
                          <span className="text-stone-500">{productionCs.bottles.noPrintJob}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title={o.recentApplications}
            action={<CardLink href="/production/station">{pages.station}</CardLink>}
          >
            {recent.items.length === 0 ? (
              <p className="text-sm text-stone-500" data-testid="no-applications">
                {o.noApplications}
              </p>
            ) : (
              <ul
                className="flex flex-col divide-y divide-stone-100 text-sm"
                data-testid="recent-applications"
              >
                {recent.items.slice(0, 8).map((r) => (
                  <li key={`${r.bottleCode}-${r.appliedAt}`} className="py-2">
                    <Link
                      href={`/bottles/${r.bottleCode}`}
                      className="font-mono font-medium hover:underline"
                    >
                      {r.bottleCode}
                    </Link>
                    <span className="block text-xs text-stone-500 wrap-anywhere">
                      {r.lotCode} · {formatDateTimeCs(r.appliedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title={o.capabilities}>
          <ul
            className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2"
            data-testid="production-capabilities"
          >
            {(
              [
                ['/bottles', pages.bottles, o.capability.bottles],
                ['/label-templates', pages.templates, o.capability.templates],
                ['/bottles/history', o.printJobsLink, o.capability.printJobs],
                ['/production/station', pages.station, o.capability.labelActivation],
              ] as const
            ).map(([href, label, text]) => (
              <li key={href} className="min-w-0">
                <Link href={href} className="font-medium hover:underline">
                  {label}
                </Link>
                <p className="text-sm text-stone-600">{text}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
