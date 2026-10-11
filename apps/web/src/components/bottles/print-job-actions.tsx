'use client';

import { labelPrintJobSchema, type LabelPrintJob } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiGet, apiSend } from '@/lib/client-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { PrintJobStatus } from '@/components/status';
import { buttonClass, ErrorNote } from '@/components/ui';

/**
 * One print job with its actions: generate (PENDING), retry (FAILED), download (COMPLETED).
 * Generation renders the same bottle identities every time; it never creates bottles.
 */
export function PrintJobActions({ initial }: { initial: LabelPrintJob }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(e instanceof Error ? e.message : 'Generation failed');
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
              title="Labels carry a DEV - NOT FOR PRODUCTION marker and DEV URLs"
            >
              DEV labels - not for real bottles
            </span>
          )}
          <span className="min-w-0 text-sm text-stone-500 wrap-anywhere">
            {job.labelCount} labels · {job.labelTemplate.label}
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
              {busy ? 'Generating…' : 'Generate labels'}
            </button>
          )}
          {job.status === 'FAILED' && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? 'Generating…' : 'Retry generation'}
            </button>
          )}
          {job.status === 'COMPLETED' && job.downloadUrl && (
            <a href={job.downloadUrl} className={buttonClass.primary} download>
              Download PDF{job.fileByteSize ? ` (${formatBytes(job.fileByteSize)})` : ''}
            </a>
          )}
        </div>
      </div>
      <p className="text-xs text-stone-500 wrap-anywhere">
        Created {formatDateTime(job.createdAt)}
        {job.completedAt && ` · completed ${formatDateTime(job.completedAt)}`}
        {job.attempts > 1 && ` · ${job.attempts} attempts`}
        {' · '}QR error correction {job.qrErrorCorrection} · one label per page at{' '}
        {job.labelTemplate.label} size · print at 100 %, no scaling
      </p>
      {job.status === 'FAILED' && job.failureReason && <ErrorNote>{job.failureReason}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Creates an additional print job for the same bottles of a batch (e.g. to reprint). */
export function NewPrintJobButton({ batchCode, label }: { batchCode: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            setError(e instanceof Error ? e.message : 'Could not create the print job');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Creating…' : label}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
