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
  const plural = (n: number) => `${n} bottle${n === 1 ? '' : 's'}`;

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
      const reason = e instanceof Error ? e.message : 'The request failed';
      setError(
        `${reason}. The bottles may or may not have been created. Pressing the button again is safe: this confirmation can never create bottles twice.`,
      );
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
            {plural(batch.quantityCreated)} created successfully
          </p>
          {replayed && (
            <p className="mb-2 text-sm text-stone-600">
              This creation had already been completed — no additional bottles were created.
            </p>
          )}
          <div className="mt-4">
            <FieldList>
              <Field label="Bottles created">{batch.quantityCreated}</Field>
              <Field label="Bottle codes">
                <span className="font-mono" data-testid="result-code-range">
                  {codeRange(batch.firstBottleCode, batch.lastBottleCode)}
                </span>
              </Field>
              <Field label="Label template">{batch.labelTemplate.label}</Field>
              <Field label="Series">
                <span className="font-mono" data-testid="result-batch-code">
                  {batch.code}
                </span>
              </Field>
            </FieldList>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href={`/bottles?batch=${batch.code}`} className={buttonClass.primary}>
              View created bottles
            </Link>
            <Link href={`/batches/${batch.code}`} className={buttonClass.secondary}>
              Series details
            </Link>
            <button type="button" className={buttonClass.secondary} onClick={startOver}>
              Create another group
            </button>
          </div>
        </Card>
        <Card title="Labels">
          {printJob ? (
            <PrintJobActions initial={printJob} />
          ) : (
            <div className="flex flex-col gap-3">
              <ErrorNote>
                The bottles were created, but their label print job could not be prepared. The
                bottles are safe — create the print job now or later from the series details.
              </ErrorNote>
              <NewPrintJobButton batchCode={batch.code} label="Create print job" />
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
          <p className="text-sm text-stone-800">
            A confirmed creation of <strong>{plural(unfinished.quantity)}</strong> did not show its
            result (for example because the page was reloaded). Finishing it is safe: if the bottles
            were already created, you get that result and no new bottles are created.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={stage === 'creating'}
              onClick={() => void submit(unfinished)}
            >
              {stage === 'creating' ? 'Checking…' : 'Finish and show result'}
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
              Discard
            </button>
          </div>
          <p className="text-xs text-stone-500">
            Discarding only forgets this confirmation here. Bottles that were already created stay
            in Bottles → Creation history.
          </p>
        </div>
      </Card>
    );
  }

  if (versions.length === 0) {
    return (
      <Card>
        <p className="text-sm text-stone-600">
          Bottles are created with a label template.{' '}
          <Link href="/label-templates/new" className="font-medium underline">
            Create a label template
          </Link>{' '}
          first.
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
            1 · Number of bottles
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
              Enter a whole number from {BOTTLE_CREATION_MIN} to {BOTTLE_CREATION_MAX}.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="template" className={labelClass}>
            2 · Label template
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
          <p className="text-xs text-stone-400">Latest version of each active template.</p>
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
              Review
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-md border border-amber-300 bg-amber-50 p-4">
            <h2 className={labelClass}>3 · Review</h2>
            <p className="text-sm text-amber-900" data-testid="create-confirmation">
              You are about to create <strong>{quantity}</strong> permanent AYVO bottle identities
              using label template <strong>{version?.label}</strong>.
            </p>
            <FieldList>
              <Field label="Bottles">{quantity}</Field>
              <Field label="Expected codes">
                {expected ? (
                  <span className="font-mono" data-testid="expected-code-range">
                    {codeRange(expected.first, expected.last)}
                  </span>
                ) : (
                  '—'
                )}
                <span className="block text-xs text-stone-500">
                  Final codes are confirmed after creation.
                </span>
              </Field>
              <Field label="Label template">
                {version?.label} ({version?.widthMm} × {version?.heightMm} mm)
              </Field>
              <Field label="QR codes">
                <span className="break-all font-mono text-xs" data-testid="qr-url-pattern">
                  {qrUrlPattern}
                </span>
                {environment !== 'production' && (
                  <span className="mt-1 block text-xs font-medium text-red-800">
                    DEV environment — every label is marked “DEV - NOT FOR PRODUCTION”.
                  </span>
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
              I understand that bottle identities are permanent and are never deleted.
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.primary}
                disabled={!acknowledged || stage === 'creating' || !registration}
                onClick={() => registration && void submit(registration)}
              >
                {stage === 'creating' ? 'Creating…' : `Create ${plural(quantity)}`}
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
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
