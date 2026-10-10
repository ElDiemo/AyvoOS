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
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { codeRange } from '@/lib/format';
import { NewPrintJobButton, PrintJobActions } from './print-job-actions';
import { buttonClass, Card, ErrorNote, FieldList, Field, inputClass } from '@/components/ui';

const QUICK_QUANTITIES = [20, 50, 100, 500];

/**
 * Registers permanent bottle identities. Deliberately two-step (review → confirm) because the
 * operation cannot be undone: bottles are never deleted.
 */
export function CreateBottlesForm({
  templates,
  preselectedVersionId,
}: {
  templates: LabelTemplateSummary[];
  preselectedVersionId?: string;
}) {
  // Only the latest version of active (not archived) templates can be used for new bottles.
  const versions = templates.filter((t) => !t.archivedAt).map((t) => t.latestVersion);
  const [versionId, setVersionId] = useState(
    versions.find((v) => v.versionId === preselectedVersionId)?.versionId ??
      versions[0]?.versionId ??
      '',
  );
  const [quantityText, setQuantityText] = useState('50');
  const [stage, setStage] = useState<'form' | 'confirm' | 'creating'>('form');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BottleRegistrationResponse | null>(null);
  // Idempotency key of the registration being confirmed: created when the user reviews, reused
  // for every retry of that confirmation, so a lost response can be retried without ever
  // creating a second batch (the server is authoritative).
  const [requestId, setRequestId] = useState<string | null>(null);

  const version = versions.find((v) => v.versionId === versionId);
  const quantity = Number(quantityText);
  const quantityValid =
    Number.isInteger(quantity) &&
    quantity >= BOTTLE_CREATION_MIN &&
    quantity <= BOTTLE_CREATION_MAX;

  async function create() {
    setStage('creating');
    setError(null);
    try {
      setResult(
        await apiSend('POST', 'admin/bottle-registrations', bottleRegistrationResponseSchema, {
          requestId,
          labelTemplateVersionId: versionId,
          quantity,
        }),
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'The request failed';
      setError(
        `${reason}. The outcome may be unknown: pressing the button again is safe — this registration can never create a second batch. You can also check Creation batches.`,
      );
      setStage('confirm');
    }
  }

  if (result) {
    const { batch, printJob, replayed } = result;
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <p role="status" className="mb-6 text-xl font-semibold text-emerald-800">
            {batch.quantityCreated} bottle{batch.quantityCreated === 1 ? '' : 's'} created
            successfully
          </p>
          {replayed && (
            <p className="mb-4 text-sm text-stone-600">
              This registration had already been completed — no additional bottles were created.
            </p>
          )}
          <FieldList>
            <Field label="Creation batch">
              <span className="font-mono" data-testid="result-batch-code">
                {batch.code}
              </span>
            </Field>
            <Field label="Template">{batch.labelTemplate.label}</Field>
            <Field label="Codes">
              <span className="font-mono">
                {codeRange(batch.firstBottleCode, batch.lastBottleCode)}
              </span>
            </Field>
          </FieldList>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href={`/batches/${batch.code}`} className={buttonClass.secondary}>
              View batch
            </Link>
            <Link href={`/bottles?batch=${batch.code}`} className={buttonClass.secondary}>
              View bottles
            </Link>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                setResult(null);
                setStage('form');
                setAcknowledged(false);
              }}
            >
              Create more bottles
            </button>
          </div>
        </Card>
        <Card title="Labels">
          {printJob ? (
            <PrintJobActions initial={printJob} />
          ) : (
            <div className="flex flex-col gap-3">
              <ErrorNote>
                The bottles were created, but the print job could not be prepared. The bottles are
                safe — create a print job now or later from the batch page.
              </ErrorNote>
              <NewPrintJobButton batchCode={batch.code} label="Create print job" />
            </div>
          )}
        </Card>
      </div>
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

  return (
    <Card>
      <div className="flex max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="template"
            className="text-xs font-medium uppercase tracking-wide text-stone-500"
          >
            Label template
          </label>
          <select
            id="template"
            value={versionId}
            disabled={stage !== 'form'}
            onChange={(e) => setVersionId(e.target.value)}
            className={inputClass}
          >
            {versions.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.label} ({v.widthMm} × {v.heightMm} mm)
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="quantity"
            className="text-xs font-medium uppercase tracking-wide text-stone-500"
          >
            Quantity
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
              disabled={stage !== 'form'}
              onChange={(e) => setQuantityText(e.target.value)}
              className={cn(inputClass, 'w-32 tabular-nums')}
            />
            {QUICK_QUANTITIES.map((q) => (
              <button
                key={q}
                type="button"
                disabled={stage !== 'form'}
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

        {stage === 'form' ? (
          <div>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!quantityValid || !version}
              onClick={() => {
                setRequestId(crypto.randomUUID());
                setStage('confirm');
              }}
            >
              Review
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm text-amber-900" data-testid="create-confirmation">
              You are about to create <strong>{quantity}</strong> permanent AYVO bottle identities
              using label template <strong>{version?.label}</strong>.
            </p>
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
                disabled={!acknowledged || stage === 'creating'}
                onClick={() => void create()}
              >
                {stage === 'creating'
                  ? 'Creating…'
                  : `Create ${quantity} bottle${quantity === 1 ? '' : 's'}`}
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
