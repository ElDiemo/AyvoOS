'use client';

import {
  BOTTLE_CREATION_MAX,
  BOTTLE_CREATION_MIN,
  bottleRegistrationResponseSchema,
  type BottleRegistrationResponse,
  type LabelTemplateSummary,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { expectedBottleCodes } from '@/lib/bottle-codes';
import { apiSend } from '@/lib/client-api';
import { codeRange } from '@/lib/format';
import {
  clearPendingRegistration,
  parsePendingRegistration,
  pendingRegistrationSnapshot,
  savePendingRegistration,
  subscribePendingRegistration,
  type PendingRegistration,
} from '@/lib/pending-registration';
import { NewPrintJobButton, PrintJobActions } from './print-job-actions';
import { buttonClass, Card, ErrorNote, FieldList, Field, inputClass } from '@/components/ui';
import { productionCs } from '@/i18n/cs/production';

const t = productionCs.create;

const QUICK_QUANTITIES = [20, 50, 100, 500];

const labelClass = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Create bottles: quantity → label template → review → confirm once → result with labels.
 * Deliberately two-step because bottles are permanent (never deleted). The idempotency key is
 * created at review and reused for every retry of that confirmation — also after a page refresh
 * (sessionStorage) — so a lost response or a double click never creates a second set of bottles.
 */
export function CreateBottlesForm({
  templates,
  preselectedVersionId,
  latestBottleCode,
  qrUrlPattern,
  environment,
}: {
  templates: LabelTemplateSummary[];
  preselectedVersionId?: string;
  /** Most recent bottle code (null if none), for the expected code range. */
  latestBottleCode: string | null;
  /** What every QR code of this environment encodes, e.g. "https://dev.ayvo.co/q/<token>". */
  qrUrlPattern: string;
  /** API environment (APP_ENV); anything but 'production' shows the DEV notice. */
  environment: string;
}) {
  // Only the latest version of active (not archived) templates can be used for new bottles.
  const versions = templates.filter((t) => !t.archivedAt).map((t) => t.latestVersion);
  const [versionId, setVersionId] = useState(
    versions.find((v) => v.versionId === preselectedVersionId)?.versionId ??
      versions[0]?.versionId ??
      '',
  );
  const [quantityText, setQuantityText] = useState('50');
  const [stage, setStage] = useState<'form' | 'review' | 'creating'>('form');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BottleRegistrationResponse | null>(null);
  const [registration, setRegistration] = useState<PendingRegistration | null>(null);
  const inFlight = useRef(false);
  // A confirmed registration whose outcome no page has shown (e.g. the page was reloaded while
  // creating). Only relevant while this page has not started its own registration.
  const stored = useSyncExternalStore(
    subscribePendingRegistration,
    pendingRegistrationSnapshot,
    () => null,
  );
  const storedRegistration = useMemo(() => parsePendingRegistration(stored), [stored]);
  const unfinished = registration ? null : storedRegistration;

  const version = versions.find((v) => v.versionId === versionId);
  const quantity = Number(quantityText);
  const quantityValid =
    Number.isInteger(quantity) &&
    quantity >= BOTTLE_CREATION_MIN &&
    quantity <= BOTTLE_CREATION_MAX;
  const expected = quantityValid ? expectedBottleCodes(latestBottleCode, quantity) : null;

  async function submit(request: PendingRegistration) {
    if (inFlight.current) return; // a second click while the first request runs
    inFlight.current = true;
    setStage('creating');
    setError(null);
    savePendingRegistration(request);
    try {
      const response = await apiSend(
        'POST',
        'admin/bottle-registrations',
        bottleRegistrationResponseSchema,
        request,
      );
      clearPendingRegistration();
      setResult(response);
    } catch (e) {
      const reason = e instanceof Error ? e.message : t.requestFailed;
      setError(t.uncertain(reason));
      setStage(unfinished ? 'form' : 'review');
    } finally {
      inFlight.current = false;
    }
  }

  function startOver() {
    setResult(null);
    setRegistration(null);
    setStage('form');
    setAcknowledged(false);
    setError(null);
  }

  if (result) {
    const { batch, printJob, replayed } = result;
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <p role="status" className="mb-2 text-xl font-semibold text-emerald-800">
            {t.success(batch.quantityCreated)}
          </p>
          {replayed && <p className="mb-2 text-sm text-stone-600">{t.replayed}</p>}
          <div className="mt-4">
            <FieldList>
              <Field label={t.created}>{batch.quantityCreated}</Field>
              <Field label={t.codes}>
                <span className="font-mono" data-testid="result-code-range">
                  {codeRange(batch.firstBottleCode, batch.lastBottleCode)}
                </span>
              </Field>
              <Field label={productionCs.bottles.template}>{batch.labelTemplate.label}</Field>
              <Field label={t.series}>
                <span className="font-mono" data-testid="result-batch-code">
                  {batch.code}
                </span>
              </Field>
            </FieldList>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href={`/bottles?batch=${batch.code}`} className={buttonClass.primary}>
              {t.viewCreated}
            </Link>
            <Link href={`/batches/${batch.code}`} className={buttonClass.secondary}>
              {t.seriesDetails}
            </Link>
            <button type="button" className={buttonClass.secondary} onClick={startOver}>
              {t.another}
            </button>
          </div>
        </Card>
        <Card title={t.labels}>
          {printJob ? (
            <PrintJobActions initial={printJob} />
          ) : (
            <div className="flex flex-col gap-3">
              <ErrorNote>{t.printJobMissing}</ErrorNote>
              <NewPrintJobButton
                batchCode={batch.code}
                label={productionCs.series.createPrintJob}
              />
            </div>
          )}
        </Card>
      </div>
    );
  }

  if (unfinished) {
    return (
      <Card>
        <div className="flex max-w-xl flex-col gap-4" data-testid="unfinished-creation">
          <p className="text-sm text-stone-800">{t.unfinished(unfinished.quantity)}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={stage === 'creating'}
              onClick={() => void submit(unfinished)}
            >
              {stage === 'creating' ? t.checking : t.finish}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={stage === 'creating'}
              onClick={() => {
                clearPendingRegistration();
                setError(null);
                setStage('form');
              }}
            >
              {t.discard}
            </button>
          </div>
          <p className="text-xs text-stone-500">{t.discardHelp}</p>
        </div>
      </Card>
    );
  }

  if (versions.length === 0) {
    return (
      <Card>
        <p className="text-sm text-stone-600">
          {t.needTemplate}{' '}
          <Link href="/label-templates/new" className="font-medium underline">
            {t.createTemplate}
          </Link>
        </p>
      </Card>
    );
  }

  const editing = stage === 'form';

  return (
    <Card>
      <div className="flex max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="quantity" className={labelClass}>
            {t.quantity}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="quantity"
              type="number"
              inputMode="numeric"
              min={BOTTLE_CREATION_MIN}
              max={BOTTLE_CREATION_MAX}
              step={1}
              value={quantityText}
              disabled={!editing}
              onChange={(e) => setQuantityText(e.target.value)}
              className={cn(inputClass, 'w-32 tabular-nums')}
            />
            {QUICK_QUANTITIES.map((q) => (
              <button
                key={q}
                type="button"
                disabled={!editing}
                onClick={() => setQuantityText(String(q))}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm tabular-nums transition',
                  quantity === q
                    ? 'border-stone-900 bg-stone-900 text-white'
                    : 'border-stone-300 bg-white hover:bg-stone-50',
                )}
              >
                {q}
              </button>
            ))}
          </div>
          {!quantityValid && (
            <p className="text-sm text-red-700">
              {t.quantityInvalid(BOTTLE_CREATION_MIN, BOTTLE_CREATION_MAX)}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="template" className={labelClass}>
            {t.template}
          </label>
          <select
            id="template"
            value={versionId}
            disabled={!editing}
            onChange={(e) => setVersionId(e.target.value)}
            className={inputClass}
          >
            {versions.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.label} ({v.widthMm} × {v.heightMm} mm)
              </option>
            ))}
          </select>
          <p className="text-xs text-stone-400">{t.templateHelp}</p>
        </div>

        {editing ? (
          <div>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!quantityValid || !version}
              onClick={() => {
                setRegistration({
                  requestId: crypto.randomUUID(),
                  labelTemplateVersionId: versionId,
                  quantity,
                });
                setStage('review');
              }}
            >
              {t.review}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-md border border-amber-300 bg-amber-50 p-4">
            <h2 className={labelClass}>{t.reviewTitle}</h2>
            <p className="text-sm text-amber-900 wrap-anywhere" data-testid="create-confirmation">
              {t.confirmation(quantity, version?.label ?? '')}
            </p>
            <FieldList>
              <Field label={t.bottles}>{quantity}</Field>
              <Field label={t.expectedCodes}>
                {expected ? (
                  <span className="font-mono" data-testid="expected-code-range">
                    {codeRange(expected.first, expected.last)}
                  </span>
                ) : (
                  '—'
                )}
                <span className="block text-xs text-stone-500">{t.finalCodes}</span>
              </Field>
              <Field label={productionCs.bottles.template}>
                {version?.label} ({version?.widthMm} × {version?.heightMm} mm)
              </Field>
              <Field label={t.qrCodes}>
                <span className="break-all font-mono text-xs" data-testid="qr-url-pattern">
                  {qrUrlPattern}
                </span>
                {environment !== 'production' && (
                  <span className="mt-1 block text-xs font-medium text-red-800">{t.devNotice}</span>
                )}
              </Field>
            </FieldList>
            <label className="flex items-start gap-2 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={stage === 'creating'}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              {t.acknowledge}
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.primary}
                disabled={!acknowledged || stage === 'creating' || !registration}
                onClick={() => registration && void submit(registration)}
              >
                {stage === 'creating' ? t.creating : t.submit(quantity)}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={stage === 'creating'}
                onClick={() => {
                  setStage('form');
                  setAcknowledged(false);
                  setError(null);
                }}
              >
                {t.back2}
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
