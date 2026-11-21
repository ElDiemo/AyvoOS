'use client';

import { pickupViewSchema, type PickupBoard as Board, type PickupView } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, reasonError, ReasonField, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { pickupsCs as t } from '@/i18n/cs/pickups';
import { pickupSummary, type Tone } from './pickup-summary';
import { apiSend, ClientApiError } from '@/lib/client-api';

const errorText = (error: unknown) =>
  error instanceof ClientApiError
    ? ((error.code && t.errors[error.code]) ?? error.message)
    : 'Požadavek se nezdařil – zkuste to znovu.';

/**
 * Expedice → Svoz (doc 029 §11). Every eligible order is selected by default and can be left out;
 * one explicit, confirmed "Objednat svoz PPL" for this site. A waiting pickup blocks a new one.
 */
export function PickupBoard({
  board,
  canOrder,
  canResolve,
}: {
  board: Board;
  canOrder: boolean;
  canResolve: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const eligible = board.candidates.filter((c) => c.eligible);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(eligible.map((c) => c.orderCode)),
  );
  const [date, setDate] = useState(board.today);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  const chosen = eligible.filter((c) => selected.has(c.orderCode));
  // The pickup announces the parcels not yet with the carrier and not held by another pickup.
  const parcels = chosen.reduce((n, c) => n + c.eligibleParcels.length, 0);
  const max = board.carrier.maxParcels;
  const windowValid = (from === '' && to === '') || (from !== '' && to !== '' && from < to);
  const blocked = !!board.open || !board.carrier.available;
  // The waiting pickup has its own card above; the history lists the others (each pickup once).
  const history = board.pickups.filter((x) => x.code !== board.open?.code);
  const canSubmit =
    canOrder && !blocked && chosen.length > 0 && windowValid && (max === null || parcels <= max);

  function toggle(code: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function submit() {
    const body = {
      date,
      window: from && to ? { from, to } : null,
      orders: chosen.map((c) => c.orderCode).sort(),
      confirmed: true as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/dispatch/pickups', pickupViewSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      setChecked(false);
      setError(null);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  return (
    <div className="space-y-4">
      <CarrierCard board={board} />
      {board.open && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">{t.open}</h2>
          <p className="mb-3 text-sm text-stone-600">{t.openBlocks}</p>
          <PickupItem pickup={board.open} canOrder={canOrder} canResolve={canResolve} />
        </Card>
      )}
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t.ready}</h2>
        {board.candidates.length === 0 ? (
          <EmptyState>{t.readyEmpty}</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-200" data-testid="pickup-candidates">
            {board.candidates.map((c) => (
              <li key={c.orderCode} className="flex items-start gap-3 py-2">
                <input
                  id={`${id}-${c.orderCode}`}
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={c.eligible && selected.has(c.orderCode)}
                  disabled={!c.eligible || !canOrder || blocked}
                  onChange={() => toggle(c.orderCode)}
                  data-testid={`pickup-select-${c.orderCode}`}
                />
                <label htmlFor={`${id}-${c.orderCode}`} className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{c.orderCode}</span> · {c.hotelName}, {c.city}
                  <span className="block text-xs text-stone-500">
                    {t.columns.shipDate}: {formatDateCs(c.requestedShipDate)} · {c.shipmentCode} ·{' '}
                    {t.columns.parcels}: {c.parcelCount}
                    {c.pickedUpCount > 0 && <> · {t.pickedUp(c.pickedUpCount)}</>}
                    {c.eligible && c.eligibleParcels.length !== c.parcelCount && (
                      <> · {t.toCollect(c.eligibleParcels.length)}</>
                    )}
                    {c.blockedBy === 'IN_PICKUP' && c.pickupCode && (
                      <> · {t.blocked.IN_PICKUP(c.pickupCode)}</>
                    )}
                    {c.blockedBy === 'OTHER_CARRIER' && <> · {t.blocked.OTHER_CARRIER}</>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {canOrder && eligible.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-stone-200 pt-4">
            <div className="flex flex-wrap gap-4">
              <label className="text-sm">
                <span className="block text-stone-700">{t.date}</span>
                <input
                  type="date"
                  className="mt-1 rounded border border-stone-300 px-2 py-1"
                  min={board.today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="pickup-date"
                />
              </label>
              <fieldset className="text-sm">
                <legend className="text-stone-700">{t.window}</legend>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={t.windowFrom}
                    className="rounded border border-stone-300 px-2 py-1"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    data-testid="pickup-from"
                  />
                  <span aria-hidden>–</span>
                  <input
                    type="time"
                    aria-label={t.windowTo}
                    className="rounded border border-stone-300 px-2 py-1"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    data-testid="pickup-to"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500">{t.windowNote}</p>
              </fieldset>
            </div>
            <p className="text-sm font-medium" data-testid="pickup-total">
              {t.total(chosen.length, parcels)}
            </p>
            {max !== null && parcels > max && (
              <p className="text-sm text-red-700">{t.tooMany(max)}</p>
            )}
            {error && !open && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!canSubmit}
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
              data-testid="pickup-order"
            >
              {t.orderButton}
            </button>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t.history}</h2>
        {history.length === 0 ? (
          <EmptyState>{t.historyEmpty}</EmptyState>
        ) : (
          <ul className="space-y-4" data-testid="pickup-history">
            {history.map((p) => (
              <li key={p.code}>
                <PickupItem pickup={p} canOrder={canOrder} canResolve={canResolve} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={open}
        title={t.confirmTitle}
        confirmLabel={t.confirmButton}
        busy={busy}
        confirmDisabled={!checked}
        onConfirm={submit}
        onCancel={() => setOpen(false)}
        testId="pickup-confirm"
      >
        <p>{t.confirmText(parcels, formatDateCs(date))}</p>
        <EnvironmentNote environment={board.carrier.environment} />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            data-testid="pickup-confirm-check"
          />
          {t.confirmCheck}
        </label>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function EnvironmentNote({ environment }: { environment: 'TEST' | 'PRODUCTION' | null }) {
  if (!environment) return null;
  return (
    <p
      className={
        environment === 'TEST'
          ? 'mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900'
          : 'mt-2 rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-900'
      }
      data-testid="pickup-environment"
    >
      {environment === 'TEST' ? t.testEnvironment : t.productionEnvironment}
    </p>
  );
}

function CarrierCard({ board }: { board: Board }) {
  const c = board.carrier;
  return (
    <Card>
      <p className="text-sm">
        <span className="text-stone-600">{t.carrier}:</span> {c.name ?? '—'}
      </p>
      {!c.available && (
        <p className="mt-1 text-sm text-red-700" data-testid="pickup-unavailable">
          {(c.reason && t.unavailable[c.reason]) ?? c.reason}
        </p>
      )}
      <EnvironmentNote environment={c.environment} />
      {c.sender && (
        <p className="mt-2 text-xs text-stone-600">
          {t.senderAddress}: {c.sender.name}, {c.sender.street}, {c.sender.postalCode}{' '}
          {c.sender.city}, {c.sender.country}
        </p>
      )}
    </Card>
  );
}

const toneClass: Record<Tone, string> = {
  ok: 'text-emerald-800',
  wait: 'text-amber-800',
  warn: 'text-red-800',
  done: 'text-stone-700',
};

/** One line of the technical detail (only rendered when it has a value). */
function Fact({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | null | undefined;
  testId?: string;
}) {
  if (!value) return null;
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-stone-500">{label}:</dt>
      <dd className="break-all text-stone-800" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function PickupItem({
  pickup: p,
  canOrder,
  canResolve,
}: {
  pickup: PickupView;
  canOrder: boolean;
  canResolve: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelChecked, setCancelChecked] = useState(false);
  const { busy, run } = useAttempt();
  const c = p.cancellation;
  const summary = pickupSummary(p);
  // An uncertain attempt (its answer not usable, or the lookups ran out): closed only by a person
  // after checking with PPL — in Podrobnosti, for `shipments:resolve_uncertain` (the API decides).
  const cancelUncertain = !!c && (c.status === 'SENT' || (c.status === 'ACCEPTED' && !c.lookingUp));
  // The attempt the closing dialog was opened for — fixed then, never "the latest" at submit.
  const [closingCancel, setClosingCancel] = useState<string | null>(null);
  const [cancelCloseReason, setCancelCloseReason] = useState('');
  const [cancelCloseChecked, setCancelCloseChecked] = useState(false);

  async function closeCancel() {
    const invalid = reasonError(cancelCloseReason);
    setError(invalid);
    if (invalid) return;
    if (!closingCancel) return;
    const body = {
      cancellationId: closingCancel,
      reason: cancelCloseReason.trim(),
      checkedWithCarrier: true as const,
    };
    const result = await run(`cancel-close:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/cancel/resolve`, pickupViewSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setClosingCancel(null);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  async function requestCancel() {
    const invalid = reasonError(cancelReason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: cancelReason.trim(), confirmed: true as const };
    const result = await run(`cancel:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/cancel`, pickupViewSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setCancelling(false);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  async function lookup() {
    const result = await run(`lookup:${p.code}`, (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/lookup`, pickupViewSchema, { requestId }),
    );
    if (result.ok) router.refresh();
    else if (result.error) setError(errorText(result.error));
  }

  async function close() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: reason.trim(), checkedWithCarrier: true as const };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/resolve`, pickupViewSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setClosing(false);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  const at = (iso: string | null | undefined) => (iso ? formatDateTimeCs(iso) : null);
  const problem = (code: string | null, message: string | null) =>
    [code, message].filter(Boolean).join(' – ') || null;

  return (
    <div className="text-sm" data-testid={`pickup-${p.code}`}>
      {/* What happened (state + its meaning), then the pickup itself. */}
      <p
        className={`font-semibold ${toneClass[summary.tone]}`}
        data-testid={`pickup-status-${p.code}`}
      >
        {summary.title}
      </p>
      <p className="text-stone-700" data-testid={`pickup-hint-${p.code}`}>
        {summary.hint}
      </p>
      <p className="mt-1 text-stone-600">
        {p.code} · {formatDateCs(p.date)}
        {p.window && ` · ${p.window.from}–${p.window.to}`} · {p.parcelCount} bal.
        {p.carrier.environment === 'TEST' && ' · TEST'}
      </p>
      {/* The parcels it affects, with the number needed to trace each one. */}
      <ul className="mt-1 text-xs text-stone-700" aria-label={t.parcels}>
        {p.parcels.map((x) => (
          <li key={x.carrierParcelNumber}>
            {x.orderCode} · {x.hotelName} · {t.parcel} {x.parcelNo} ({x.carrierParcelNumber})
          </li>
        ))}
      </ul>
      {canOrder && summary.action === 'cancel' && (
        <div className="mt-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => {
              setError(null);
              setCancelling(true);
            }}
            data-testid={`pickup-cancel-button-${p.code}`}
          >
            {t.cancel}
          </button>
        </div>
      )}
      {canOrder && summary.action === 'lookup' && (
        <div className="mt-2">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy}
            onClick={lookup}
            data-testid={`pickup-lookup-${p.code}`}
          >
            {t.lookup}
          </button>
        </div>
      )}
      {error && !closing && !cancelling && closingCancel === null && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      <details
        className="mt-2 rounded border border-stone-200"
        data-testid={`pickup-details-${p.code}`}
      >
        <summary className="cursor-pointer px-2 py-2 text-sm font-medium text-stone-700">
          {t.details.summary}
        </summary>
        <div className="space-y-2 px-2 pb-2 text-xs">
          <dl className="space-y-0.5">
            <Fact label={t.details.carrierNumber} value={p.carrierOrderNumber} />
            <Fact label={t.details.carrierState} value={p.carrierState} />
            <Fact label={t.details.reference} value={p.reference} />
            <Fact
              label={t.details.systemState}
              value={p.status}
              testId={`pickup-system-state-${p.code}`}
            />
            <Fact label={t.details.error} value={problem(p.errorCode, p.errorMessage)} />
            <Fact label={t.details.resolution} value={p.resolutionReason} />
            <Fact label={t.details.createdAt} value={at(p.createdAt)} />
            <Fact label={t.details.sentAt} value={at(p.sentAt)} />
            <Fact label={t.details.resolvedAt} value={at(p.resolvedAt)} />
            <Fact label={t.details.lookupFrom} value={at(p.lookupFrom)} />
          </dl>
          {c && (
            <dl
              className="space-y-0.5 border-t border-stone-200 pt-2"
              data-testid={`pickup-cancel-${p.code}`}
            >
              <Fact label={t.details.cancel} value={c.status} />
              <Fact label={t.details.cancelReason} value={c.reason} />
              <Fact label={t.details.carrierState} value={c.carrierState} />
              <Fact label={t.details.error} value={problem(c.errorCode, c.errorMessage)} />
              <Fact label={t.details.resolution} value={c.resolutionReason} />
              <Fact label={t.details.sentAt} value={at(c.sentAt)} />
              <Fact label={t.details.resolvedAt} value={at(c.resolvedAt)} />
              <Fact label={t.details.lookups} value={c.lookups > 0 ? String(c.lookups) : null} />
              <Fact label={t.details.nextLookup} value={at(c.nextLookupAt)} />
              <Fact label={t.details.lookupFrom} value={at(c.lookupFrom)} />
              <Fact label={t.details.cancelId} value={c.id} />
            </dl>
          )}
          <div className="border-t border-stone-200 pt-2">
            <p className="text-stone-500">{t.plan}:</p>
            <p className="text-stone-400">{t.planNote}</p>
            <ul className="text-stone-700">
              {p.parcels.map((x) => (
                <li key={x.carrierParcelNumber} data-testid="pickup-parcel-now">
                  {x.carrierParcelNumber} – {t.parcelNow}:{' '}
                  {x.withCarrierNow
                    ? t.parcelWithCarrierNow
                    : (t.orderStatus[x.orderStatus] ?? x.orderStatus)}
                </li>
              ))}
            </ul>
          </div>
          {canResolve && (cancelUncertain || p.status === 'SENT') && (
            <div className="space-y-2 border-t border-stone-200 pt-2">
              <p className="font-medium text-stone-700">{t.details.support}</p>
              <p className="text-stone-600">{t.details.supportNote}</p>
              <div className="flex flex-wrap gap-2">
                {cancelUncertain && (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => {
                      setError(null);
                      setClosingCancel(c.id);
                    }}
                    data-testid={`pickup-cancel-resolve-${p.code}`}
                  >
                    {t.cancelResolve}
                  </button>
                )}
                {/* Too early is refused by the API (PICKUP_IN_FLIGHT) and said so. */}
                {p.status === 'SENT' && (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => setClosing(true)}
                    data-testid={`pickup-resolve-${p.code}`}
                  >
                    {t.resolve}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </details>
      <ConfirmDialog
        open={closing}
        title={t.resolveTitle}
        confirmLabel={t.resolveConfirm}
        danger
        busy={busy}
        confirmDisabled={!checked}
        onConfirm={close}
        onCancel={() => setClosing(false)}
        testId={`pickup-resolve-dialog-${p.code}`}
      >
        <p>{t.resolveText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {t.resolveCheck}
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={cancelling}
        title={t.cancelTitle}
        confirmLabel={t.cancelConfirm}
        danger
        busy={busy}
        confirmDisabled={!cancelChecked}
        onConfirm={requestCancel}
        onCancel={() => setCancelling(false)}
        testId={`pickup-cancel-dialog-${p.code}`}
      >
        <p>{t.cancelText}</p>
        <ReasonField
          id={`${id}-cancel-reason`}
          value={cancelReason}
          onChange={setCancelReason}
          error={error}
        />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={cancelChecked}
            onChange={(e) => setCancelChecked(e.target.checked)}
            data-testid={`pickup-cancel-check-${p.code}`}
          />
          {t.cancelCheck}
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={closingCancel !== null}
        title={t.cancelResolveTitle}
        confirmLabel={t.cancelResolveConfirm}
        danger
        busy={busy}
        confirmDisabled={!cancelCloseChecked}
        onConfirm={closeCancel}
        onCancel={() => setClosingCancel(null)}
        testId={`pickup-cancel-resolve-dialog-${p.code}`}
      >
        <p>{t.cancelResolveText}</p>
        <ReasonField
          id={`${id}-cancel-close-reason`}
          value={cancelCloseReason}
          onChange={setCancelCloseReason}
          error={error}
        />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={cancelCloseChecked}
            onChange={(e) => setCancelCloseChecked(e.target.checked)}
          />
          {t.cancelResolveCheck}
        </label>
      </ConfirmDialog>
    </div>
  );
}
