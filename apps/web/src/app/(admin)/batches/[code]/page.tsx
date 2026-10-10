import { bottleCreationBatchSchema, labelPrintJobListResponseSchema } from '@ayvo/types';
import Link from 'next/link';
import { NewPrintJobButton, PrintJobActions } from '@/components/bottles/print-job-actions';
import { buttonClass, Card, EmptyState, Field, FieldList, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { codeRange, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BatchPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const path = `admin/bottle-batches/${encodeURIComponent(code)}`;
  const [batch, jobs] = await Promise.all([
    apiGet(path, bottleCreationBatchSchema),
    apiGet(`${path}/print-jobs`, labelPrintJobListResponseSchema),
  ]);
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{batch.code}</span>}
        subtitle="Creation batch"
        back={{ href: '/batches', label: 'Creation batches' }}
        actions={
          <Link href={`/bottles?batch=${batch.code}`} className={buttonClass.secondary}>
            View bottles
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <Card title="Batch">
          <FieldList>
            <Field label="Created">
              {batch.quantityCreated} bottle{batch.quantityCreated === 1 ? '' : 's'}
            </Field>
            <Field label="Template">{batch.labelTemplate.label}</Field>
            <Field label="Bottle range">
              <span className="font-mono">
                {codeRange(batch.firstBottleCode, batch.lastBottleCode)}
              </span>
            </Field>
            <Field label="Created at">{formatDateTime(batch.createdAt)}</Field>
          </FieldList>
        </Card>
        <Card>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium uppercase tracking-wide text-stone-500">
              Print jobs
            </h2>
            <NewPrintJobButton
              batchCode={batch.code}
              label={jobs.items.length === 0 ? 'Create print job' : 'New print job (reprint)'}
            />
          </div>
          {jobs.items.length === 0 ? (
            <EmptyState>No print jobs yet.</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              {jobs.items.map((job) => (
                <PrintJobActions key={`${job.code}-${job.status}`} initial={job} />
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-stone-400">
            Every print job renders exactly these {batch.quantityCreated} bottles with{' '}
            {batch.labelTemplate.label}. Printing never creates or removes bottles.
          </p>
        </Card>
      </div>
    </>
  );
}
