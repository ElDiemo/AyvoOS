'use client';

import {
  API_BASE_PATH,
  CRATE_LABEL_SIZE_MM,
  crateLabelLayout,
  crateLabelPrintJobSchema,
  type CrateLabelPrintJob,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import {
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  SuccessNote,
  useAttempt,
  useFocusFirstError,
} from '@/components/catalog/form-kit';
import { buttonClass, Card } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { apiSend } from '@/lib/client-api';
import { crateErrorText, parseMm } from './crate-form-kit';

const t = cratesCs.print;
const { min, max } = CRATE_LABEL_SIZE_MM;

/**
 * QR labels for a fixed list of crates at a size the user enters (not approved yet, doc 025 Q7):
 * the QR size is computed from the shared layout before anything is created, a preview opens a
 * placeholder PDF, and "Vytvořit PDF" creates one print job (idempotent per attempt). A reprint is
 * the same action for one crate: same token, same URL.
 */
export function PrintLabelsForm({
  crateCodes,
  crateTypeCode,
  title = t.title,
  help = t.help,
}: {
  crateCodes: string[];
  crateTypeCode: string;
  title?: string;
  help?: string;
}) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<CrateLabelPrintJob | null>(null);
  const { busy, run } = useAttempt();

  const w = parseMm(width, min, max);
  const h = parseMm(height, min, max);
  const layout = w && h ? crateLabelLayout(w, h) : null;
  const previewHref =
    w && h && layout
      ? `${API_BASE_PATH}/admin/crate-label-preview?widthMm=${w}&heightMm=${h}&crateType=${encodeURIComponent(crateTypeCode)}`
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = {
      width: w ? null : t.sizeInvalid,
      height: h ? null : t.sizeInvalid,
    };
    setErrors(next);
    setFormError(w && h && !layout ? t.tooSmall : null);
    if (next.width || next.height) return focusError();
    if (!layout) return;
    const body = { crateCodes, widthMm: w!, heightMm: h! };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/crate-label-print-jobs', crateLabelPrintJobSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setJob(result.value);
      router.refresh();
    } else if (result.error) setFormError(crateErrorText(result.error));
  }

  async function retry() {
    if (!job) return;
    const result = await run(`retry:${job.code}`, () =>
      apiSend(
        'POST',
        `admin/crate-label-print-jobs/${job.code}/generate`,
        crateLabelPrintJobSchema,
      ),
    );
    if (result.ok) {
      setJob(result.value);
      router.refresh();
    } else if (result.error) setFormError(crateErrorText(result.error));
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card title={title}>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4"
        data-testid="print-labels"
      >
        <p className="text-sm text-stone-600">{help}</p>
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <FormField id={f('width')} label={t.width} error={errors.width}>
            <input
              id={f('width')}
              inputMode="numeric"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              aria-invalid={!!errors.width}
              aria-describedby={describedBy(f('width'), false, !!errors.width)}
              className={fieldClass(!!errors.width)}
            />
          </FormField>
          <FormField id={f('height')} label={t.height} error={errors.height}>
            <input
              id={f('height')}
              inputMode="numeric"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              aria-invalid={!!errors.height}
              aria-describedby={describedBy(f('height'), false, !!errors.height)}
              className={fieldClass(!!errors.height)}
            />
          </FormField>
        </div>
        {w && h && (
          <p className="text-sm" data-testid="label-size-note" aria-live="polite">
            {layout ? (
              <>
                {t.qrSize(layout.qr.sizeMm.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }))}{' '}
                <span className="text-amber-900">{t.notApproved}</span>
              </>
            ) : (
              <span className="text-red-800">{t.tooSmall}</span>
            )}
          </p>
        )}
        <ErrorSummary errors={errors} formError={formError} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? t.working : t.submit(crateCodes.length)}
          </button>
          {previewHref ? (
            <a href={previewHref} target="_blank" rel="noopener" className={buttonClass.secondary}>
              {t.preview}
            </a>
          ) : (
            <span
              className={`${buttonClass.secondary} pointer-events-none opacity-50`}
              aria-disabled="true"
            >
              {t.preview}
            </span>
          )}
        </div>
        <p className="text-xs text-stone-500">{t.previewHelp}</p>
        {job && (
          <div data-testid="print-result" className="flex flex-col gap-2">
            {job.status === 'COMPLETED' ? (
              <>
                <SuccessNote>{t.completed(job.code)}</SuccessNote>
                <a
                  href={job.downloadUrl!}
                  className={`${buttonClass.primary} self-start`}
                  data-testid="download-pdf"
                >
                  {t.download}
                </a>
                {job.environment !== 'production' && (
                  <p className="text-xs text-amber-900">{t.devLabels}</p>
                )}
              </>
            ) : (
              <div role="alert" className="flex flex-col gap-2 text-sm text-red-800">
                <p>{t.failed(job.code)}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void retry()}
                  className={`${buttonClass.secondary} self-start`}
                >
                  {t.retry}
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}
