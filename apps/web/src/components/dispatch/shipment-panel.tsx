'use client';

import {
  orderShipmentSchema,
  type OrderShipment,
  type OrderStatus,
  type ShipmentParcel,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import {
  ConfirmDialog,
  FormField,
  ReasonField,
  describedBy,
  fieldClass,
  reasonError,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, Card, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { ordersCs } from '@/i18n/cs/orders';
import { shipmentsCs } from '@/i18n/cs/shipments';
import { apiSend } from '@/lib/client-api';
import { formatDimensions, formatMass, kgToG } from '@/lib/measure';
import { orderErrorText } from './order-errors';
import { shipmentPhase, type ShipmentPhase } from './shipment-phase';

const t = shipmentsCs;
const p = t.phase;

type Props = {
  code: string;
  status: OrderStatus;
  data: OrderShipment;
  canPrepare: boolean;
  canHandOver: boolean;
  /** `shipments:resolve_uncertain`: the exceptional manual closing of an uncertain request. */
  canResolveUncertain: boolean;
  timeZone: string;
};

/** Phases in which the carrier may still answer by itself: the page refreshes on its own. */
const WAITING: ShipmentPhase[] = ['ACCEPTED', 'CREATED', 'CANCELLING', 'IN_FLIGHT', 'PREPARED'];

/**
 * Přeprava on the order detail: one main next step, the parcels (one per crate) with the
 * calculated reference, an optional actual weighing and the carrier number, the stored labels.
 */
export function ShipmentPanel({
  code,
  status,
  data,
  canPrepare,
  canHandOver,
  canResolveUncertain,
  timeZone,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const phase = shipmentPhase(status, data);
  const s = data.shipment;
  const parcels = s?.parcels.length ?? 0;
  const parcelWord = ordersCs.detail.parcels(parcels);
  const labelsHref = `/api/admin/orders/${code}/shipment/labels`;
  const waiting = !!phase && WAITING.includes(phase) && !s?.pollingStopped;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [waiting, router]);

  const send = (path: string, body: object) =>
    apiSend('POST', `admin/orders/${code}/shipment/${path}`, orderShipmentSchema, body);
  const done = () => {
    setError(null);
    router.refresh();
  };
  const failed = (e: unknown) => setError(uncertain(e) ? t.uncertain : orderErrorText(e));

  return (
    <div className="mb-6 flex flex-col gap-6">
      {phase && (
        <Card title={t.nextStep} testId="shipment-next-step">
          <div data-phase={phase} data-testid="shipment-phase" className="flex flex-col gap-3">
            <NextStep
              phase={phase}
              parcelWord={parcelWord}
              data={data}
              canPrepare={canPrepare}
              canHandOver={canHandOver}
              send={send}
              onDone={done}
              onError={failed}
              labelsHref={labelsHref}
              timeZone={timeZone}
            />
            {error && (
              <p
                role="alert"
                className="text-sm font-medium text-red-700"
                data-testid="shipment-error"
              >
                {error}
              </p>
            )}
          </div>
        </Card>
      )}
      {s && (
        <Card
          title={t.parcels}
          testId="shipment-parcels"
          action={
            <span className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
              {t.shipment(s.code)}
              {s.carrier.name && ` · ${t.carrier(s.carrier.name)}`}
              {s.carrier.environment === 'TEST' && (
                <span
                  className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-900"
                  data-testid="carrier-test-environment"
                >
                  {t.testEnvironment}
                </span>
              )}
            </span>
          }
        >
          {s.carrierShipmentRef && (
            <p className="mb-3 text-sm" data-testid="carrier-ref">
              {t.carrierRef(s.carrierShipmentRef)}
            </p>
          )}
          {s.carrier.configured && (
            <p className="mb-3 text-xs text-stone-500">
              {t.ruleLine(
                t.rules[s.carrier.parcelWeight ?? ''] ?? '',
                t.rules[s.carrier.parcelDimensions ?? ''] ?? '',
              )}
            </p>
          )}
          <ul className="flex flex-col divide-y divide-stone-200">
            {s.parcels.map((parcel) => (
              <ParcelRow
                key={parcel.parcelNo}
                parcel={parcel}
                editable={s.status === 'DRAFT' && canPrepare}
                code={code}
                labelHref={`/api/admin/orders/${code}/shipment/parcels/${parcel.parcelNo}/label`}
                timeZone={timeZone}
                onDone={done}
              />
            ))}
          </ul>
          {s.label && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <a
                href={labelsHref}
                target="_blank"
                rel="noopener"
                className={buttonClass.secondary}
                data-testid="open-labels"
              >
                {t.openLabels}
              </a>
              <span className="text-xs text-stone-500">{t.labelsNote}</span>
            </div>
          )}
          {canResolveUncertain &&
            (phase === 'UNCERTAIN' || phase === 'ACCEPTED' || phase === 'IN_FLIGHT') && (
              <details className="mt-4 text-sm" data-testid="shipment-exceptional">
                <summary className="cursor-pointer text-stone-600">{t.more}</summary>
                <div className="mt-3">
                  <AbandonUncertain send={send} onDone={done} />
                </div>
              </details>
            )}
          {canPrepare &&
            (s.status === 'LABELED' ||
              (s.status === 'REQUESTING' && s.request?.status === 'CREATED')) &&
            status !== 'HANDED_TO_CARRIER' && (
              <details className="mt-4 text-sm" data-testid="shipment-more">
                <summary className="cursor-pointer text-stone-600">{t.more}</summary>
                <div className="mt-3">
                  {s.carrier.canCancel ? (
                    <CancelPreparation send={send} onDone={done} />
                  ) : (
                    <p className="text-stone-500">{t.cancelUnsupported}</p>
                  )}
                </div>
              </details>
            )}
        </Card>
      )}
      {data.cancelled.length > 0 && (
        <Card title={t.cancelled} testId="shipment-cancelled">
          <ul className="flex flex-col gap-1 text-sm">
            {data.cancelled.map((c) => (
              <li key={c.code}>
                {t.cancelledLine(c.code, c.cancelledBy, c.reason)} ·{' '}
                {formatDateTimeCs(c.cancelledAt, timeZone)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

type Send = (path: string, body: object) => Promise<OrderShipment>;

function NextStep({
  phase,
  parcelWord,
  data,
  canPrepare,
  canHandOver,
  send,
  onDone,
  onError,
  labelsHref,
  timeZone,
}: {
  phase: ShipmentPhase;
  parcelWord: string;
  data: OrderShipment;
  canPrepare: boolean;
  canHandOver: boolean;
  send: Send;
  onDone: () => void;
  onError: (e: unknown) => void;
  labelsHref: string;
  timeZone: string;
}) {
  const { busy, run } = useAttempt();
  const [dialog, setDialog] = useState<'ready' | 'handover' | null>(null);
  // The clock is read after mount and every 5 s (never during render).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  const [checked, setChecked] = useState(false);
  const parcels = data.shipment?.parcels.length ?? 0;

  async function action(key: string, path: string, body: object = {}) {
    const result = await run(key, (requestId) => send(path, { requestId, ...body }));
    if (result.ok) {
      setDialog(null);
      setChecked(false);
      onDone();
    } else if (result.error) onError(result.error);
  }
  const primary = (label: string, onClick: () => void, testId: string) => (
    <div>
      <button
        type="button"
        className={buttonClass.primary}
        disabled={busy}
        onClick={onClick}
        data-testid={testId}
      >
        {label}
      </button>
    </div>
  );
  const heading = (title: string, text?: string) => (
    <div>
      <p className="font-semibold">{title}</p>
      {text && <p className="mt-1 text-sm text-stone-600">{text}</p>}
    </div>
  );

  switch (phase) {
    case 'NO_SHIPMENT':
      return (
        <>
          {heading(p.createLabels, p.noShipment)}
          {canPrepare && primary(p.createLabels, () => action('labels', 'labels'), 'create-labels')}
        </>
      );
    case 'NO_CARRIER': {
      const reason = data.shipment?.carrier.unavailable ?? data.carrier.unavailable;
      return (
        <Notice tone="warning">
          <span className="font-semibold">{p.noCarrier}.</span> {p.noCarrierText}{' '}
          <span data-testid="carrier-unavailable">{reason ? p.noCarrierReason[reason] : ''}</span>
        </Notice>
      );
    }
    case 'MISSING':
      return (
        <>
          {heading(p.missing, p.missingText)}
          <ul className="list-disc pl-5 text-sm" data-testid="shipment-missing">
            {data.shipment!.missing.map((m, i) => (
              <li key={i}>{t.missingField[m.field]?.(m.parcelNo) ?? m.field}</li>
            ))}
          </ul>
        </>
      );
    case 'CREATE':
      return (
        <>
          {heading(p.createLabels, p.createLabelsText(parcelWord))}
          {canPrepare && primary(p.createLabels, () => action('labels', 'labels'), 'create-labels')}
        </>
      );
    case 'PREPARED':
    case 'IN_FLIGHT':
    case 'UNCERTAIN':
    case 'ACCEPTED':
    case 'CREATED': {
      const texts = {
        PREPARED: [p.prepared, p.pendingText],
        IN_FLIGHT: [p.inFlight, p.inFlightText],
        UNCERTAIN: [p.pending, p.pendingText],
        ACCEPTED: [p.accepted, p.acceptedText],
        CREATED: [p.created, p.createdText],
      }[phase];
      const request = data.shipment?.request;
      const notYet =
        phase === 'IN_FLIGHT' &&
        !!request?.resolvableAt &&
        (now === null || new Date(request.resolvableAt).getTime() > now);
      return (
        <>
          <Notice tone="warning">
            <span className="font-semibold">{texts[0]}.</span> {texts[1]}
          </Notice>
          {data.shipment?.pollingStopped && <p className="text-sm">{p.pollingStopped}</p>}
          {notYet ? (
            <p className="text-sm text-stone-600" data-testid="resolvable-at">
              {p.resolvableAt(formatDateTimeCs(request!.resolvableAt, timeZone))}
            </p>
          ) : (
            canPrepare && primary(p.resolve, () => action('resolve', 'resolve'), 'resolve-labels')
          )}
        </>
      );
    }
    case 'CANCELLING':
      return (
        <>
          <Notice tone="warning">
            <span className="font-semibold">{p.cancelling}.</span> {p.cancellingText}
          </Notice>
          {canPrepare &&
            primary(
              p.resolveCancel,
              () => action('cancel-resolve', 'cancel/resolve'),
              'resolve-cancel',
            )}
        </>
      );
    case 'LABELED':
      return (
        <>
          {heading(p.labeled, p.labeledText(labelWord(parcels)))}
          <div className="flex flex-wrap gap-3">
            {canPrepare && (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setDialog('ready')}
                data-testid="confirm-ready"
              >
                {p.confirmReady}
              </button>
            )}
            <a href={labelsHref} target="_blank" rel="noopener" className={buttonClass.secondary}>
              {t.openLabels}
            </a>
          </div>
          <ConfirmDialog
            open={dialog === 'ready'}
            title={t.readyDialog.title}
            confirmLabel={t.readyDialog.confirm}
            busy={busy}
            confirmDisabled={!checked}
            onConfirm={() => checked && action('ready', 'ready', { labelsApplied: true })}
            onCancel={() => setDialog(null)}
            testId="ready-dialog"
          >
            <p>{t.readyDialog.text}</p>
            <Check checked={checked} onChange={setChecked} label={t.readyDialog.check(parcels)} />
          </ConfirmDialog>
        </>
      );
    case 'READY_FOR_PICKUP':
      return (
        <>
          {heading(p.readyForPickup, p.readyForPickupText)}
          {canHandOver && (
            <div>
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setDialog('handover')}
                data-testid="confirm-handover"
              >
                {p.confirmHandOver}
              </button>
            </div>
          )}
          <ConfirmDialog
            open={dialog === 'handover'}
            title={t.handOverDialog.title}
            confirmLabel={t.handOverDialog.confirm}
            busy={busy}
            confirmDisabled={!checked}
            onConfirm={() => checked && action('handover', 'hand-over', { handedOver: true })}
            onCancel={() => setDialog(null)}
            testId="handover-dialog"
          >
            <p>{t.handOverDialog.text}</p>
            <Check checked={checked} onChange={setChecked} label={t.handOverDialog.check} />
          </ConfirmDialog>
        </>
      );
    case 'HANDED_OVER':
      return (
        <Notice tone="info">
          <span className="font-semibold">{p.handedOver}.</span> {p.handedOverText}
        </Notice>
      );
  }
}

const labelWord = (n: number) => `${n} ${n === 1 ? 'štítek' : n < 5 ? 'štítky' : 'štítků'}`;

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="mt-3 flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ParcelRow({
  parcel,
  editable,
  code,
  labelHref,
  timeZone,
  onDone,
}: {
  parcel: ShipmentParcel;
  editable: boolean;
  code: string;
  labelHref: string;
  timeZone: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = parcel.reference;
  const d = parcel.dimensions;
  return (
    <li className="py-3" data-testid={`parcel-${parcel.parcelNo}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-medium">
          {t.parcel(parcel.parcelNo)} · <span className="font-mono">{parcel.crate}</span>
        </p>
        <p className="text-sm text-stone-600">
          {parcel.product.name} · {t.bottles(parcel.bottles)}
        </p>
      </div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-stone-500">{t.reference}</dt>
          <dd data-testid={`parcel-${parcel.parcelNo}-reference`}>
            {formatMass(ref.massG) ?? t.unknown}
            {ref.source && (
              <span className="text-xs text-stone-500"> ({t.referenceSource[ref.source]})</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">{t.actual}</dt>
          <dd data-testid={`parcel-${parcel.parcelNo}-actual`}>
            {parcel.actual ? (
              <>
                {formatMass(parcel.actual.massG)}{' '}
                <span className="text-xs text-stone-500">
                  (
                  {t.actualBy(
                    parcel.actual.recordedBy,
                    formatDateTimeCs(parcel.actual.recordedAt, timeZone),
                  )}
                  )
                </span>
              </>
            ) : (
              t.notWeighed
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">{t.dimensions}</dt>
          <dd>{d ? formatDimensions(d.lengthMm, d.widthMm, d.heightMm) : t.unknown}</dd>
        </div>
        {parcel.carrierParcelNumber && (
          <div>
            <dt className="text-xs text-stone-500">{t.carrierNumber}</dt>
            <dd className="font-mono" data-testid={`parcel-${parcel.parcelNo}-number`}>
              {parcel.carrierParcelNumber}
            </dd>
          </div>
        )}
      </dl>
      {parcel.label && (
        <a
          href={labelHref}
          target="_blank"
          rel="noopener"
          className="mt-2 inline-block text-sm underline underline-offset-2"
          data-testid={`parcel-${parcel.parcelNo}-label`}
        >
          {t.parcelLabel(parcel.label.format)}
        </a>
      )}
      {editable && !open && (
        <button
          type="button"
          className={cn(buttonClass.secondary, 'mt-2')}
          onClick={() => setOpen(true)}
          data-testid={`weigh-${parcel.parcelNo}`}
        >
          {parcel.actual ? t.reweigh : t.weigh}
        </button>
      )}
      {editable && open && (
        <WeighForm
          code={code}
          parcel={parcel}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      )}
    </li>
  );
}

function WeighForm({
  code,
  parcel,
  onClose,
  onDone,
}: {
  code: string;
  parcel: ShipmentParcel;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [kg, setKg] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ kg?: string; reason?: string; form?: string }>({});
  const { busy, run } = useAttempt();
  const correcting = parcel.actual !== null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const massG = kgToG(kg.trim().replace(',', '.'));
    const next: typeof errors = {};
    if (!massG) next.kg = t.weighInvalid;
    if (correcting) next.reason = reasonError(reason) ?? undefined;
    setErrors(next);
    if (next.kg || next.reason) return;
    const body = {
      massG,
      correctionOf: correcting ? parcel.actual!.id : null,
      correctionReason: correcting ? reason.trim() : null,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'POST',
        `admin/orders/${code}/shipment/parcels/${parcel.parcelNo}/weighings`,
        orderShipmentSchema,
        { requestId, ...body },
      ),
    );
    if (result.ok) onDone();
    else if (result.error)
      setErrors({ form: uncertain(result.error) ? t.uncertain : orderErrorText(result.error) });
  }

  return (
    <form
      onSubmit={save}
      noValidate
      className="mt-3 flex max-w-md flex-col gap-3"
      data-testid={`weigh-form-${parcel.parcelNo}`}
    >
      <FormField id={`${id}-kg`} label={t.weighLabel} help={t.weighHelp} error={errors.kg}>
        <input
          id={`${id}-kg`}
          inputMode="decimal"
          autoFocus
          value={kg}
          onChange={(e) => setKg(e.target.value)}
          aria-invalid={!!errors.kg}
          aria-describedby={describedBy(`${id}-kg`, true, !!errors.kg)}
          className={fieldClass(!!errors.kg)}
        />
      </FormField>
      {correcting && (
        <ReasonField
          id={`${id}-reason`}
          value={reason}
          onChange={setReason}
          error={errors.reason}
          label={t.weighReason}
        />
      )}
      {errors.form && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {errors.form}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" className={buttonClass.primary} disabled={busy}>
          {t.weighSave}
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          {t.close}
        </button>
      </div>
    </form>
  );
}

function CancelPreparation({ send, onDone }: { send: Send; onDone: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      send('cancel', { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      onDone();
    } else if (result.error)
      setError(uncertain(result.error) ? t.uncertain : orderErrorText(result.error));
  }

  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen(true)}
        data-testid="cancel-shipment"
      >
        {t.cancel}
      </button>
      <ConfirmDialog
        open={open}
        title={t.cancelTitle}
        confirmLabel={t.cancelConfirm}
        danger
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        testId="cancel-shipment-dialog"
      >
        <p>{t.cancelText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
      </ConfirmDialog>
    </>
  );
}

/**
 * The exceptional manual closing of an uncertain request (`shipments:resolve_uncertain`): a
 * reason and an explicit check of the duplicate risk; audited with the user's name.
 */
function AbandonUncertain({ send, onDone }: { send: Send; onDone: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid || !checked) return;
    const body = { reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      send('abandon', { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      onDone();
    } else if (result.error)
      setError(uncertain(result.error) ? t.uncertain : orderErrorText(result.error));
  }

  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen(true)}
        data-testid="abandon-request"
      >
        {t.abandon}
      </button>
      <ConfirmDialog
        open={open}
        title={t.abandonTitle}
        confirmLabel={t.abandonConfirm}
        danger
        busy={busy}
        confirmDisabled={!checked}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        testId="abandon-dialog"
      >
        <p>{t.abandonText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        <Check checked={checked} onChange={setChecked} label={t.abandonCheck} />
      </ConfirmDialog>
    </>
  );
}
