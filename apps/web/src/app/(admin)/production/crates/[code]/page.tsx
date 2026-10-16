import { crateCodeSchema, crateDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { PrintJobList } from '@/components/crates/print-job-list';
import { PrintLabelsForm } from '@/components/crates/print-labels-form';
import { ProductionHeader } from '@/components/production/production-header';
import { Card, Field, FieldList } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs;

/** Detail of one physical crate: identity, last recorded location, history, QR print jobs. */
export default async function CrateDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!crateCodeSchema.safeParse(code).success) notFound();
  const [me, crate, timeZone] = await Promise.all([
    currentUser(),
    apiGet(`admin/crates/${code}`, crateDetailSchema),
    siteTimeZone(),
  ]);
  return (
    <>
      <ProductionHeader
        active="crates"
        title={<span className="font-mono">{crate.code}</span>}
        subtitle={`${crate.crateType.name} · ${crate.crateType.code} · ${t.capacity(crate.crateType.capacity)}`}
        back={{ href: '/production/crates', label: t.backToList }}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card testId="crate-facts">
          <FieldList>
            <Field label={t.columns.circulation}>
              <span data-testid="crate-circulation">
                {crate.cycle
                  ? t.cycleLine(
                      t.cycleStatus[crate.cycle.status] ?? crate.cycle.status,
                      crate.cycle.memberCount,
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
