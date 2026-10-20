'use client';

import type { OrderShipment, PrintJobStatus, ShipmentParcel } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { useId, useState } from 'react';
import {
  ConfirmDialog,
  ReasonField,
  reasonError,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, Card, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { shipmentsCs } from '@/i18n/cs/shipments';
import { orderErrorText } from './order-errors';
import { printTargets } from './print-status';

const t = shipmentsCs.print;
type Send = (path: string, body: object) => Promise<OrderShipment>;

/** Jobs still on their way to a printer (the page refreshes by itself while there are any). */
export const ACTIVE_JOB: PrintJobStatus[] = ['QUEUED', 'CLAIMED', 'SENDING'];

const tone: Record<PrintJobStatus, string> = {
  QUEUED: 'border-stone-300 bg-stone-50 text-stone-800',
  CLAIMED: 'border-sky-300 bg-sky-50 text-sky-900',
  SENDING: 'border-sky-300 bg-sky-50 text-sky-900',
  SENT: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  FAILED: 'border-red-300 bg-red-50 text-red-900',
  UNCERTAIN: 'border-amber-400 bg-amber-50 text-amber-950',
  CANCELLED: 'border-stone-300 bg-stone-100 text-stone-600',
};

export function JobChip({ status, testId }: { status: PrintJobStatus; testId?: string }) {
  return (
    <span
      className={cn('rounded border px-1.5 py-0.5 text-xs font-semibold', tone[status])}
      data-testid={testId}
      data-status={status}
    >
      {t.status[status]}
    </span>
  );
}

/**
 * Tisk štítků on the order (doc 030 §7): where the labels go, how far each one is, PDF preview
 * and files per parcel, re-print of ONE parcel. Nothing here says "printed" — only "sent to the
 * printer"; the operator confirms the applied labels separately.
 */
export function PrintCard({
  code,
  data,
  canPrint,
  canReprint,
  canPrepare,
  send,
  onDone,
  timeZone,
}: {
  code: string;
  data: OrderShipment;
  canPrint: boolean;
  canReprint: boolean;
  canPrepare: boolean;
  send: Send;
  onDone: () => void;
  timeZone: string;
}) {
  const s = data.shipment!;
  const printer = data.printer;
  const [error, setError] = useState<string | null>(null);
  const printing = useAttempt();
  const retrying = useAttempt();
  const latest = s.parcels.map((p) => p.printJobs[0] ?? null);
  const anyJob = latest.some((j) => j !== null);
  const sent = latest.filter((j) => j?.status === 'SENT').length;
  const zpl = s.zpl;
  const targets = printTargets(data);

  async function printAll() {
    if (!printer) return;
    const result = await printing.run(`print:${printer.id}`, (requestId) =>
      send('print', { requestId, printerId: printer.id }),
    );
    if (result.ok) onDone();
    else if (result.error)
      setError(uncertain(result.error) ? shipmentsCs.uncertain : orderErrorText(result.error));
  }
  async function retryZpl() {
    const result = await retrying.run('zpl-retry', (requestId) => send('zpl/retry', { requestId }));
    if (result.ok) onDone();
    else if (result.error)
      setError(uncertain(result.error) ? shipmentsCs.uncertain : orderErrorText(result.error));
  }

  return (
    <Card title={t.title} testId="print-card">
      <div className="flex flex-col gap-3 text-sm">
        {/* UI38-R1: work on its way keeps its printer; a new print goes to the default. */}
        {targets.active.length > 0 && (
          <p data-testid="print-active-target">
            <span className="font-medium">{t.activeTarget(targets.active.join(', '))}</span>
          </p>
        )}
        {printer ? (
          <p data-testid="print-target">
            <span className={targets.active.length > 0 ? '' : 'font-medium'}>
              {t.target(`${printer.name} (${printer.model})`)}
            </span>
            {/* A state is shown only while the agent reports in — never a stale "ready". */}
            {printer.agent.online && printer.reportedState && (
              <span className="text-stone-600"> · {t.printerState[printer.reportedState]}</span>
            )}
          </p>
        ) : (
          <Notice tone="warning">{t.noPrinter}</Notice>
        )}
        {printer && !printer.agent.online && (
          <Notice tone="warning">{t.agentOffline(printer.agent.code)}</Notice>
        )}
        {zpl?.status === 'PENDING' && (
          <p className="text-stone-600" data-testid="zpl-pending">
            {t.zplPending}
          </p>
        )}
        {zpl?.status === 'FAILED' && (
          <Notice tone="warning">
            <span className="font-semibold" data-testid="zpl-failed">
              {t.zplFailed}
            </span>{' '}
            {zpl.errorMessage}
          </Notice>
        )}
        {zpl && zpl.status !== 'DONE' && canPrepare && (
          <div>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={retrying.busy}
              onClick={() => void retryZpl()}
              data-testid="zpl-retry"
            >
              {t.zplRetry}
            </button>
          </div>
        )}
        {s.printWaiting.map((w, i) => (
          <p key={i} className="text-stone-600" data-testid="print-waiting">
            {t.waiting(w.printer)}
          </p>
        ))}
        {!anyJob && s.printWaiting.length === 0 && canPrint && printer && (
          <div>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={printing.busy}
              onClick={() => void printAll()}
              data-testid="print-all"
            >
              {t.printAll(s.parcels.length, printer.name)}
            </button>
          </div>
        )}
        {anyJob && (
          <p data-testid="print-summary">
            <span className="font-medium">{t.summary(sent, s.parcels.length)}</span>{' '}
            <span className="text-stone-600">{t.sentNote}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="font-medium text-red-700" data-testid="print-error">
            {error}
          </p>
        )}
        <ul className="flex flex-col divide-y divide-stone-200">
          {s.parcels.map((p) => (
            <ParcelPrint
              key={p.parcelNo}
              code={code}
              parcel={p}
              printer={printer}
              canPrint={canPrint}
              canReprint={canReprint}
              send={send}
              onDone={onDone}
              timeZone={timeZone}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ParcelPrint({
  code,
  parcel,
  printer,
  canPrint,
  canReprint,
  send,
  onDone,
  timeZone,
}: {
  code: string;
  parcel: ShipmentParcel;
  printer: OrderShipment['printer'];
  canPrint: boolean;
  canReprint: boolean;
  send: Send;
  onDone: () => void;
  timeZone: string;
}) {
  const base = `/api/admin/orders/${code}/shipment/parcels/${parcel.parcelNo}`;
  const pdf = parcel.labels.find((l) => l.format === 'PDF');
  const zpl = parcel.labels.find((l) => l.format === 'ZPL');
  const job = parcel.printJobs[0] ?? null;
  const [preview, setPreview] = useState(false);
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`print-parcel-${parcel.parcelNo}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{shipmentsCs.parcel(parcel.parcelNo)}</span>
        <span className="font-mono text-xs">{parcel.crate}</span>
        {parcel.carrierParcelNumber && (
          <span className="font-mono text-xs">{parcel.carrierParcelNumber}</span>
        )}
        {job && <JobChip status={job.status} testId={`print-parcel-${parcel.parcelNo}-status`} />}
      </div>
      {job?.status === 'UNCERTAIN' && <p className="text-xs text-amber-900">{t.uncertainHelp}</p>}
      {job?.detail && job.status !== 'SENT' && (
        <p className="text-xs text-stone-600">{job.detail}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {pdf && (
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              aria-expanded={preview}
              onClick={() => setPreview((v) => !v)}
              data-testid={`preview-${parcel.parcelNo}`}
            >
              {t.preview}
            </button>
            <a
              href={`${base}/label`}
              target="_blank"
              rel="noopener"
              className="text-sm underline underline-offset-2"
              data-testid={`pdf-${parcel.parcelNo}`}
            >
              {t.pdf}
            </a>
          </>
        )}
        {zpl && canPrint && (
          <a
            href={`${base}/label/zpl`}
            className="text-sm underline underline-offset-2"
            data-testid={`zpl-${parcel.parcelNo}`}
          >
            {t.zpl(zpl.dpi)}
          </a>
        )}
        {canReprint && printer && zpl && (
          <Reprint
            parcel={parcel}
            printer={printer.name}
            printerId={printer.id}
            send={send}
            onDone={onDone}
            busyJob={!!job && ACTIVE_JOB.includes(job.status)}
          />
        )}
      </div>
      {preview && pdf && (
        <iframe
          src={`${base}/label#toolbar=0`}
          title={`${t.preview} – ${shipmentsCs.parcel(parcel.parcelNo)}`}
          className="h-96 w-full max-w-md rounded border border-stone-200 bg-white"
          data-testid={`preview-frame-${parcel.parcelNo}`}
        />
      )}
      {parcel.printJobs.length > 0 && (
        <details className="text-xs text-stone-600">
          <summary className="cursor-pointer">{t.history}</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {parcel.printJobs.map((j) => (
              <li key={j.code} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{t.job(j.code)}</span>
                <JobChip status={j.status} />
                <span>
                  {j.printer} · {j.requestedBy} · {formatDateTimeCs(j.createdAt, timeZone)}
                </span>
                {j.reason && <span>· {j.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function Reprint({
  parcel,
  printer,
  printerId,
  send,
  onDone,
  busyJob,
}: {
  parcel: ShipmentParcel;
  printer: string;
  printerId: string;
  send: Send;
  onDone: () => void;
  busyJob: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  // A label that may already exist physically: the duplicate risk must be acknowledged.
  const risk = parcel.printJobs.some((j) => j.status === 'SENT' || j.status === 'UNCERTAIN');

  async function confirm() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid || (risk && !checked)) return;
    const body = { printerId, reason: reason.trim(), acknowledgeDuplicate: risk && checked };
    const result = await run(JSON.stringify(body), (requestId) =>
      send(`parcels/${parcel.parcelNo}/reprint`, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      setReason('');
      setChecked(false);
      onDone();
    } else if (result.error)
      setError(uncertain(result.error) ? shipmentsCs.uncertain : orderErrorText(result.error));
  }

  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={busyJob}
        onClick={() => setOpen(true)}
        data-testid={`reprint-${parcel.parcelNo}`}
      >
        {t.reprint}
      </button>
      <ConfirmDialog
        open={open}
        title={t.reprintTitle(parcel.parcelNo)}
        confirmLabel={t.reprintConfirm}
        busy={busy}
        confirmDisabled={risk && !checked}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        testId={`reprint-dialog-${parcel.parcelNo}`}
      >
        <p>{t.reprintText(printer)}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        {risk && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              data-testid="reprint-duplicate"
            />
            <span>{t.duplicateCheck}</span>
          </label>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Labels of cancelled shipments that may physically exist: to be removed or destroyed. */
export function LabelsToDestroy({ data }: { data: OrderShipment }) {
  const list = data.cancelled.filter((c) => c.labelsToDestroy.length > 0);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((c) => (
        <Notice key={c.code} tone="warning">
          <span className="font-semibold" data-testid="labels-to-destroy">
            {t.destroyTitle(c.code)}
          </span>{' '}
          {t.destroyText}
          <ul className="mt-1 list-disc pl-5">
            {c.labelsToDestroy.map((l) => (
              <li key={l.parcelNo}>{t.destroyLine(l.parcelNo, l.crate, l.number)}</li>
            ))}
          </ul>
        </Notice>
      ))}
    </>
  );
}
