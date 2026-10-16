import { crateCodeSchema, crateContentSchema, crateDetailSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CrateCorrections } from '@/components/crates/crate-corrections';
import { PrintJobList } from '@/components/crates/print-job-list';
import { PrintLabelsForm } from '@/components/crates/print-labels-form';
import { ProductionHeader } from '@/components/production/production-header';
import { BottleStatusBadge } from '@/components/status';
import { Card, Field, FieldList } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs;

/**
 * Detail of one physical crate (doc 025 A1, A5): its open cycle (product, recipe, design, Obsah and
 * Naplněno), the bottles in it with their state and liquid lot, aborted circulations, the history
 * with corrections and their reasons, QR print jobs — and, for production:cycle_correct, the
 * supervisor's corrections.
 */
export default async function CrateDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!crateCodeSchema.safeParse(code).success) notFound();
  const [me, crate, content, timeZone] = await Promise.all([
    currentUser(),
    apiGet(`admin/crates/${code}`, crateDetailSchema),
    apiGet(`admin/crates/${code}/content`, crateContentSchema),
    siteTimeZone(),
  ]);
  const cycle = content.cycle;
  return (
    <>
      <ProductionHeader
        active="crates"
        title={<span className="font-mono">{crate.code}</span>}
        subtitle={`${crate.crateType.name} · ${crate.crateType.code} · ${t.capacity(crate.crateType.capacity)}`}
        back={{ href: '/production/crates', label: t.backToList }}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t.content.title} testId="crate-content-card" className="lg:col-span-2">
          {!cycle ? (
            <p className="text-sm text-stone-700">{t.content.none}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <FieldList>
                <Field label={t.columns.circulation}>
                  <span data-testid="crate-cycle-status">
                    {t.cycleStatus[cycle.status] ?? cycle.status}
                  </span>
                </Field>
                <Field label={t.content.counts}>
                  <span className="font-semibold tabular-nums" data-testid="crate-counts">
                    {t.content.countsValue(cycle.memberCount, cycle.filledCount, cycle.capacity)}
                  </span>
                </Field>
                <Field label={t.content.product}>
                  {cycle.product.name} ({cycle.product.code})
                </Field>
                <Field label={t.content.recipeLabel}>{t.content.recipe(cycle.recipeVersion)}</Field>
                <Field label={t.content.design}>{cycle.design.label}</Field>
                <Field label={t.content.opened}>{formatDateTimeCs(cycle.openedAt, timeZone)}</Field>
                {cycle.filledAt && (
                  <Field label={t.content.readyAt}>
                    {formatDateTimeCs(cycle.filledAt, timeZone)}
                  </Field>
                )}
              </FieldList>
              <h3 className="text-sm font-semibold">{t.content.members}</h3>
              {content.members.length === 0 ? (
                <p className="text-sm text-stone-700">{t.content.noMembers}</p>
              ) : (
                <ol
                  className="flex flex-col divide-y divide-stone-100 text-sm"
                  data-testid="crate-members"
                >
                  {content.members.map((m) => (
                    <li
                      key={m.ordinal}
                      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2 md:grid-cols-[3rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center"
                      data-testid={`member-${m.bottle.code}`}
                    >
                      <span className="tabular-nums text-stone-500">{m.ordinal}.</span>
                      <Link
                        href={`/bottles/${m.bottle.code}`}
                        className="font-mono underline-offset-2 hover:underline"
                      >
                        {m.bottle.code}
                      </Link>
                      <span className="col-start-2 md:col-start-auto">
                        <BottleStatusBadge status={m.bottle.status} />
                      </span>
                      <span className="col-start-2 text-xs text-stone-600 md:col-start-auto">
                        {t.content.sources[m.source] ?? m.source}
                      </span>
                      <span className="col-start-2 text-xs text-stone-600 md:col-start-auto">
                        {m.liquidLot ? `${t.content.lot}: ${m.liquidLot}` : '—'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {content.aborted.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">{t.content.aborted}</h3>
              <ul className="mt-1 text-xs text-stone-600">
                {content.aborted.map((a, i) => (
                  <li key={i}>
                    {t.content.abortedLine(
                      a.product.name,
                      formatDateTimeCs(a.abortedAt, timeZone),
                      a.reason,
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        {hasPermission(me, 'production:cycle_correct') && (
          <CrateCorrections crateCode={crate.code} status={cycle?.status ?? null} />
        )}
        <Card testId="crate-facts">
          <FieldList>
            <Field label={t.columns.circulation}>
              <span data-testid="crate-circulation">
                {crate.cycle
                  ? t.cycleLine(
                      t.cycleStatus[crate.cycle.status] ?? crate.cycle.status,
                      crate.cycle.memberCount,
                      crate.cycle.filledCount,
                      crate.cycle.capacity,
                      crate.cycle.product.name,
                    )
                  : t.noCirculation}
              </span>
              <span className="mt-1 block text-xs text-stone-500">{t.noCirculationHelp}</span>
            </Field>
            <Field label={t.columns.location}>
              <span data-testid="crate-location">
                {crate.lastLocation
                  ? `${crate.lastLocation.name} (${crate.lastLocation.code})`
                  : t.notRecorded}
              </span>
              {!crate.lastLocation && (
                <span className="mt-1 block text-xs text-stone-500">{t.notRecordedHelp}</span>
              )}
            </Field>
            <Field label={t.site}>
              {crate.site.name} ({crate.site.code})
            </Field>
            <Field label={t.registration}>
              <span className="font-mono">{crate.registrationCode}</span> ·{' '}
              {formatDateTimeCs(crate.createdAt, timeZone)}
            </Field>
            <Field label={t.crateStatus}>{t.status[crate.status] ?? crate.status}</Field>
            <Field label={t.qrUrl}>
              <span className="font-mono text-xs wrap-anywhere" data-testid="crate-qr-url">
                {crate.qrUrl}
              </span>
              <span className="mt-1 block text-xs text-stone-500">{t.qrUrlHelp}</span>
            </Field>
          </FieldList>
        </Card>
        {hasPermission(me, 'crates:register') && (
          <PrintLabelsForm
            crateCodes={[crate.code]}
            crateTypeCode={crate.crateType.code}
            title={t.print.reprintTitle}
            help={`${t.print.reprintHelp} ${t.print.help}`}
          />
        )}
        <Card title={t.printJobs} testId="crate-print-jobs">
          <PrintJobList
            jobs={crate.printJobs}
            timeZone={timeZone}
            canRetry={hasPermission(me, 'crates:register')}
          />
        </Card>
        <Card title={t.history} testId="crate-history">
          <ol className="flex flex-col divide-y divide-stone-100 text-sm">
            {crate.events.map((e, i) => (
              <li key={i} className="py-2">
                <span className="font-medium">{t.eventType[e.type] ?? e.type}</span>
                {e.printJobCode && <span className="font-mono"> · {e.printJobCode}</span>}
                {e.registrationCode && <span className="font-mono"> · {e.registrationCode}</span>}
                {e.bottle && <span className="font-mono"> · {t.eventBottle(e.bottle)}</span>}
                {e.reason && <span> · {t.eventReason(e.reason)}</span>}
                <span className="block text-xs text-stone-500">
                  {formatDateTimeCs(e.occurredAt, timeZone)} · {t.eventBy(e.actor)}
                  {e.location && ` · ${e.location.name}`}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
