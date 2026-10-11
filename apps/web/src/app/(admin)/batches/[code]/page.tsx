import {
  bottleCreationBatchCodeSchema,
  bottleCreationBatchSchema,
  labelPrintJobListResponseSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NewPrintJobButton, PrintJobActions } from '@/components/production/print-job-actions';
import { ProductionHeader } from '@/components/production/production-header';
import { buttonClass, Card, EmptyState, Field, FieldList } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { bottlesWord, productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';
import { codeRange } from '@/lib/format';

const t = productionCs.series;

export const dynamic = 'force-dynamic';

/** Detail of one bottle creation (a creation batch in the backend): its bottles and labels. */
export default async function BatchPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!bottleCreationBatchCodeSchema.safeParse(code).success) notFound();
  const path = `admin/bottle-batches/${encodeURIComponent(code)}`;
  const [batch, jobs] = await Promise.all([
    apiGet(path, bottleCreationBatchSchema),
    apiGet(`${path}/print-jobs`, labelPrintJobListResponseSchema),
  ]);
  return (
    <>
      <ProductionHeader
        active="bottles"
        title={<span className="font-mono">{batch.code}</span>}
        subtitle={t.subtitle(batch.quantityCreated)}
        back={{ href: '/bottles/history', label: t.back }}
        actions={
          <Link href={`/bottles?batch=${batch.code}`} className={buttonClass.secondary}>
            {t.viewBottles}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <Card title={t.summary}>
          <FieldList>
            <Field label={t.bottles}>{bottlesWord(batch.quantityCreated)}</Field>
            <Field label={t.template}>{batch.labelTemplate.label}</Field>
            <Field label={t.range}>
              <span className="font-mono">
                {codeRange(batch.firstBottleCode, batch.lastBottleCode)}
              </span>
            </Field>
            <Field label={t.createdAt}>{formatDateTimeCs(batch.createdAt)}</Field>
          </FieldList>
        </Card>
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-sm font-medium uppercase tracking-wide text-stone-500">
              {t.labels}
            </h2>
            <NewPrintJobButton
              batchCode={batch.code}
              label={jobs.items.length === 0 ? t.createPrintJob : t.reprint}
            />
          </div>
          {jobs.items.length === 0 ? (
            <EmptyState>{t.noPrintJob}</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              {jobs.items.map((job) => (
                <PrintJobActions key={`${job.code}-${job.status}`} initial={job} />
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-stone-400 wrap-anywhere">
            {t.footnote(batch.quantityCreated, batch.labelTemplate.label)}
          </p>
        </Card>
      </div>
    </>
  );
}
