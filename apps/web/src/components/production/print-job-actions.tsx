'use client';

import { labelPrintJobSchema, type LabelPrintJob } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiGet, apiSend } from '@/lib/client-api';
import { formatBytes } from '@/lib/format';
import { PrintJobStatus } from '@/components/status';
import { buttonClass, DetailFact, Details, ErrorNote } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { productionError, ProductionErrorNote, type ProductionError } from './production-errors';

const t = productionCs.printJob;

/**
 * One print job with its actions: generate (PENDING), retry (FAILED), download (COMPLETED).
 * Generation renders the same bottle identities every time; it never creates bottles.
 */
export function PrintJobActions({ initial }: { initial: LabelPrintJob }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProductionError | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    setJob((j) => ({ ...j, status: 'GENERATING' }));
    try {
      setJob(
        await apiSend('POST', `admin/label-print-jobs/${job.code}/generate`, labelPrintJobSchema),
      );
      router.refresh();
    } catch (e) {
      setError(productionError(e));
      // The server may still be generating (or may have finished): show its real state.
      setJob(
        await apiGet(`admin/label-print-jobs/${job.code}`, labelPrintJobSchema).catch(() => job),
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`print-job-${job.code}`}
      className="flex flex-col gap-3 rounded-md border border-stone-200 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-medium">{job.code}</span>
          <PrintJobStatus status={busy ? 'GENERATING' : job.status} />
          {job.environment !== 'production' && (
            <span
              className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 ring-1 ring-red-600/20 ring-inset"
              title={productionCs.common.devLabelsHint}
            >
              {productionCs.common.devLabels}
            </span>
          )}
          <span className="min-w-0 text-sm text-stone-500 wrap-anywhere">
            {t.labels(job.labelCount, job.labelTemplate.label)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {job.status === 'PENDING' && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? t.generating : t.generate}
            </button>
          )}
          {job.status === 'FAILED' && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? t.generating : t.retry}
            </button>
          )}
          {job.status === 'COMPLETED' && job.downloadUrl && (
            <a href={job.downloadUrl} className={buttonClass.primary} download>
              {t.download(job.fileByteSize ? formatBytes(job.fileByteSize) : '')}
            </a>
          )}
        </div>
      </div>
      <p className="text-xs text-stone-500 wrap-anywhere">
        {t.details({
          created: formatDateTimeCs(job.createdAt),
          completed: job.completedAt ? formatDateTimeCs(job.completedAt) : null,
          template: job.labelTemplate.label,
        })}
      </p>
      {job.status === 'FAILED' && <ErrorNote>{t.failed}</ErrorNote>}
      <Details testId={`print-job-${job.code}-details`}>
        <dl>
          <DetailFact label={t.attempts} value={String(job.attempts)} />
          <DetailFact label={t.qrLevel} value={job.qrErrorCorrection} />
          <DetailFact
            label={t.failureReason}
            value={job.status === 'FAILED' ? job.failureReason : null}
          />
        </dl>
      </Details>
      {error && <ProductionErrorNote error={error} />}
    </div>
  );
}

/** Creates an additional print job for the same bottles of a batch (e.g. to reprint). */
export function NewPrintJobButton({ batchCode, label }: { batchCode: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProductionError | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiSend(
              'POST',
              `admin/bottle-batches/${batchCode}/print-jobs`,
              labelPrintJobSchema,
            );
            router.refresh();
          } catch (e) {
            setError(productionError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t.creating : label}
      </button>
      {error && <ProductionErrorNote error={error} />}
    </div>
  );
}
