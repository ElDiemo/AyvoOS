'use client';

import { crateLabelPrintJobSchema, type CrateLabelPrintJob } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, EmptyState } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiSend } from '@/lib/client-api';
import { crateErrorText } from './crate-form-kit';

const t = cratesCs;

/**
 * The stored print jobs of a crate (newest first). A stored job that the server would render now
 * (PENDING, FAILED or abandoned GENERATING — `retryable`) can be rendered again from here, also
 * after a reload: the SAME job with its fixed crates, size and URLs — never a new job.
 */
export function PrintJobList({
  jobs,
  timeZone,
  canRetry,
}: {
  jobs: CrateLabelPrintJob[];
  timeZone: string;
  canRetry: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const { busy, run } = useAttempt();

  async function retry(code: string) {
    setError(null);
    const result = await run(`generate:${code}`, () =>
      apiSend('POST', `admin/crate-label-print-jobs/${code}/generate`, crateLabelPrintJobSchema),
    );
    if (result.ok) {
      if (result.value.status !== 'COMPLETED') setError({ code, text: t.print.failed(code) });
      router.refresh();
    } else if (result.error) {
      setError({ code, text: crateErrorText(result.error) });
      router.refresh();
    }
  }

  if (jobs.length === 0) return <EmptyState>{t.noPrintJobs}</EmptyState>;
  return (
    <ul className="flex flex-col divide-y divide-stone-100 text-sm" data-testid="print-job-list">
      {jobs.map((job) => (
        <li
          key={job.code}
          className="flex flex-col gap-1 py-2"
          data-testid={`print-job-${job.code}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 wrap-anywhere">
              <span className="font-mono">{job.code}</span> ·{' '}
              {t.job.size(job.widthMm, job.heightMm)} ·{' '}
              <span data-testid="print-job-status">
                {t.printJobStatus[job.status] ?? job.status}
              </span>
              <span className="block text-xs text-stone-500">
                {formatDateTimeCs(job.createdAt, timeZone)} · {t.job.by(job.createdBy)}
              </span>
            </span>
            {job.downloadUrl ? (
              <a href={job.downloadUrl} className="text-sm font-medium underline">
                {t.print.download}
              </a>
            ) : canRetry && job.retryable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void retry(job.code)}
                className={buttonClass.secondary}
              >
                {busy ? t.print.working : t.print.retry}
              </button>
            ) : null}
          </div>
          {job.status === 'FAILED' && job.failureReason && (
            <p className="text-xs text-red-800">{t.job.failed}</p>
          )}
          {job.status === 'GENERATING' && !job.retryable && (
            <p className="text-xs text-stone-600">{t.job.running}</p>
          )}
          {error?.code === job.code && (
            <p role="alert" className="text-xs text-red-800">
              {error.text}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
