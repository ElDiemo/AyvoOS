'use client';

import {
  fillingStateSchema,
  fillScanResultSchema,
  finishCrateResultSchema,
  type FillingState,
} from '@ayvo/types';
import { useEffect, useId, useRef, useState } from 'react';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { fillingCs } from '@/i18n/cs/filling';
import { labelingCs } from '@/i18n/cs/labeling';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { scanFeedback } from '@/lib/scan-feedback';
import { ScanQueueStatus, useScanQueue, type QueueItem } from './use-scan-queue';

const t = fillingCs;
type Notice = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

const uncertain = (error: unknown) => !(error instanceof ClientApiError) || error.status >= 500;

function errorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && t.errors[error.code]) return t.errors[error.code]!;
    if (error.status === 403) return t.errors.FORBIDDEN!;
    if (error.status < 500) return labelingCs.failed;
  }
  return labelingCs.network;
}

/**
 * The filling station's work (doc 025 A4): load the SAME crate that was assembled at labelling,
 * choose the liquid lot explicitly, then scan each bottle AFTER it was filled and its pump
 * installed ("Potvrdit naplnění"): the server checks the bottle is a member of this crate and
 * consumes liquid + pump once. Obsah and Naplněno are shown separately; only Hotovo (a full crate,
 * every bottle filled) makes it ready. Scans, crate loads and Hotovo go through the shared queue:
 * an uncertain answer keeps its request id, stops the queue and blocks crate, lot and leaving.
 */
export function FillingWorkspace({
  sessionId,
  onUnresolvedChange,
}: {
  sessionId: string;
  onUnresolvedChange?: (unresolved: boolean) => void;
}) {
  const id = useId();
  const base = `admin/station-sessions/${sessionId}`;
  const [state, setState] = useState<FillingState | null>(null);
  const [lot, setLot] = useState('');
  const [editingLot, setEditingLot] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [log, setLog] = useState<{ id: number; tone: string; text: string }[]>([]);
  const lotAttempt = useRef<{ key: string; id: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const stateRef = useRef<FillingState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let alive = true;
    apiGet(`${base}/filling`, fillingStateSchema)
      .then((s) => {
        if (alive) setState(s);
      })
      .catch((error: unknown) => {
        if (alive) setNotice({ tone: 'error', text: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [base]);

  const cycle = state?.crate?.cycle ?? null;
  const lotReady = !!state?.liquidLot && !editingLot;
  const phase: 'crate' | 'lot' | 'bottle' = !state?.crate ? 'crate' : lotReady ? 'bottle' : 'lot';

  // The scanner types into whatever has focus: keep the active scan field focused (also once the
  // state has loaded and the field appears).
  const loaded = state !== null;
  useEffect(() => {
    if (loaded && phase !== 'lot') input.current?.focus();
  }, [loaded, phase, notice]);

  const push = (tone: string, text: string) =>
    setLog((l) => [{ id: Date.now() + Math.random(), tone, text }, ...l].slice(0, 15));

  /** Explicit lot choice; an uncertain attempt keeps its request id for the retry. */
  async function applyLot() {
    if (!lot || busy) return;
    const key = `lot:${lot}:${state?.contextRevision}`;
    if (lotAttempt.current?.key !== key) lotAttempt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    try {
      const s = await apiSend('POST', `${base}/liquid-lot`, fillingStateSchema, {
        requestId: lotAttempt.current.id,
        liquidLotId: lot,
      });
      lotAttempt.current = null;
      setState(s);
      setEditingLot(false);
      setNotice({ tone: 'ok', text: t.lot.changed(s.liquidLot!.code) });
    } catch (error) {
      if (!uncertain(error)) lotAttempt.current = null;
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  /** Sends one queued item; false = no definite answer (the queue stops on it). */
  async function process(item: QueueItem): Promise<boolean> {
    try {
      if (item.kind === 'crate') {
        const s = await apiSend('POST', `${base}/filling-crate`, fillingStateSchema, {
          requestId: item.requestId,
          scannedValue: item.raw,
        });
        setState(s);
        setEditingLot(!s.liquidLot);
        setLot(s.liquidLot?.id ?? '');
        setNotice({ tone: 'ok', text: t.crate.loaded(s.crate!.code, !!s.liquidLot) });
        scanFeedback('ok');
      } else if (item.kind === 'finish') {
        const r = await apiSend('POST', `${base}/finish`, finishCrateResultSchema, {
          requestId: item.requestId,
          contextRevision: item.revision,
        });
        setState(await apiGet(`${base}/filling`, fillingStateSchema));
        setNotice({ tone: 'ok', text: t.finish.done(r.crate.code) });
        push('ok', t.finish.done(r.crate.code));
        scanFeedback('ok');
      } else {
        const r = await apiSend('POST', `${base}/fill-scans`, fillScanResultSchema, {
          requestId: item.requestId,
          scannedValue: item.raw,
          contextRevision: item.revision,
        });
        setState((s) =>
          s
            ? {
                ...s,
                crate: s.crate ? { ...s.crate, cycle: r.cycle } : s.crate,
                liquidLot:
                  s.liquidLot && r.outcome === 'FILLED'
                    ? { ...s.liquidLot, onHand: r.liquidLot.onHand }
                    : s.liquidLot,
              }
            : s,
        );
        const text =
          r.outcome === 'FILLED'
            ? t.scan.filled(r.bottle.code, r.cycle.filledCount, r.cycle.capacity)
            : t.scan.already(r.bottle.code);
        setNotice({ tone: r.outcome === 'FILLED' ? 'ok' : 'warn', text });
        push(r.outcome === 'FILLED' ? 'ok' : 'warn', text);
        scanFeedback(r.outcome === 'FILLED' ? 'ok' : 'error');
      }
      return true;
    } catch (error) {
      scanFeedback('error');
      if (uncertain(error)) {
        push('error', labelingCs.scan.uncertainLog);
        return false;
      }
      let text = errorText(error);
      if (error instanceof ClientApiError && error.code === 'CRATE_NOT_COMPLETE') {
        const c = stateRef.current?.crate?.cycle;
        if (c) text = t.finish.notYet(c.memberCount, c.filledCount, c.capacity);
      }
      setNotice({ tone: 'error', text });
      push('error', text);
      return true;
    }
  }

  const q = useScanQueue((item) => process(item), onUnresolvedChange);
  const unresolved = q.unresolved;

  function submit(raw: string) {
    q.enqueue({
      kind: phase === 'crate' ? 'crate' : 'scan',
      raw,
      revision: stateRef.current?.contextRevision ?? 0,
    });
    setValue('');
  }

  if (!state) return notice ? <NoticeBox notice={notice} /> : null;

  const unit = state.liquidItem?.unitCode ?? '';
  const complete =
    !!cycle &&
    cycle.status === 'FILLING' &&
    cycle.memberCount === cycle.capacity &&
    cycle.filledCount === cycle.capacity;

  return (
    <div className="flex flex-col gap-4" data-testid="filling">
      <div
        className="grid grid-cols-2 gap-3 rounded-lg border border-stone-300 bg-white p-4 sm:grid-cols-[1fr_auto_auto]"
        data-testid="filling-crate"
      >
        <p className="col-span-2 text-sm sm:col-span-1">
          <span className="block text-xs uppercase tracking-wide text-stone-500">
            {t.crate.title}
          </span>
          <span className="font-mono text-lg font-semibold">{state.crate?.code ?? '—'}</span>
          {cycle && (
            <span className="block text-xs text-stone-500" data-testid="filling-recipe">
              {t.crate.recipe(cycle.product.name, cycle.recipeVersion)}
            </span>
          )}
        </p>
        <p className="text-center" data-testid="crate-content">
          <span className="block text-xs uppercase tracking-wide text-stone-500">
            {t.crate.content}
          </span>
          <span className="text-2xl font-bold tabular-nums">
            {cycle?.memberCount ?? 0}/{state.crate?.capacity ?? '—'}
          </span>
        </p>
        <p className="text-center" data-testid="crate-filled">
          <span className="block text-xs uppercase tracking-wide text-stone-500">
            {t.crate.filled}
          </span>
          <span className="text-2xl font-bold tabular-nums text-emerald-800">
            {cycle?.filledCount ?? 0}/{state.crate?.capacity ?? '—'}
          </span>
        </p>
      </div>

      {state.crate && (
        <Card title={t.lot.title}>
          {lotReady ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium" data-testid="filling-lot">
                {t.lot.current(state.liquidLot!.code, state.liquidLot!.onHand, unit)}
                {state.liquidItem && state.pumpItem && (
                  <span className="block text-xs text-stone-500">
                    {t.lot.perBottle(
                      state.liquidItem.quantity,
                      unit,
                      state.liquidItem.name,
                      state.pumpItem.name,
                    )}
                  </span>
                )}
              </p>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={unresolved}
                onClick={() => {
                  setLot(state.liquidLot!.id);
                  setEditingLot(true);
                }}
              >
                {t.lot.change}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3" data-testid="filling-lot-form">
              <p className="text-xs text-stone-500">{t.lot.help}</p>
              {state.lots.length === 0 ? (
                <p className="text-sm text-amber-900">{t.lot.none}</p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-lot`}>
                    {t.lot.title}
                    <select
                      id={`${id}-lot`}
                      value={lot}
                      onChange={(e) => setLot(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">{t.lot.choose}</option>
                      {state.lots.map((l) => (
                        <option key={l.id} value={l.id}>
                          {t.lot.option(l.code, l.onHand, unit)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={buttonClass.primary}
                    disabled={busy || unresolved || !lot}
                    onClick={() => void applyLot()}
                  >
                    {t.lot.apply}
                  </button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card>
        {phase !== 'lot' && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit(value);
            }}
            data-testid={phase === 'crate' ? 'crate-scan' : 'bottle-scan'}
          >
            <label htmlFor={`${id}-scan`} className="text-sm font-medium">
              {phase === 'crate' ? t.crate.scan : t.scan.label}
            </label>
            <input
              id={`${id}-scan`}
              ref={input}
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              className={`${inputClass} text-lg`}
            />
            <p className="text-xs text-stone-500" aria-live="polite">
              {busy || q.busy
                ? labelingCs.scan.checking
                : phase === 'crate'
                  ? t.crate.help
                  : t.scan.help}
            </p>
          </form>
        )}
        {/* The crate's own controls never depend on a liquid lot chosen for the NEXT bottle: a
            completely filled crate (e.g. repacked finished bottles) is finished, and another crate
            loaded, even when no liquid is in stock (PR #24 review A4-R2). */}
        {state.crate && (
          <div
            className={`${phase === 'lot' ? '' : 'mt-3 '}flex flex-wrap items-center gap-3`}
            data-testid="filling-crate-actions"
          >
            <button
              type="button"
              className={buttonClass.primary}
              disabled={unresolved || !complete}
              onClick={() =>
                q.enqueue({ kind: 'finish', raw: '', revision: state.contextRevision })
              }
              data-testid="filling-finish"
            >
              {t.finish.button}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={unresolved}
              onClick={() => {
                setEditingLot(false);
                setState((s) => (s ? { ...s, crate: null } : s));
              }}
            >
              {t.crate.change}
            </button>
            <p className="w-full text-xs text-stone-500">
              {complete
                ? t.finish.help
                : cycle
                  ? t.finish.notYet(cycle.memberCount, cycle.filledCount, cycle.capacity)
                  : t.finish.help}
            </p>
          </div>
        )}
      </Card>
      <ScanQueueStatus queue={q} testIdPrefix="filling" focusScan={() => input.current?.focus()} />
      {notice && <NoticeBox notice={notice} />}
      {log.length > 0 && (
        <ol className="flex flex-col gap-1 text-sm" data-testid="filling-log">
          {log.map((e) => (
            <li
              key={e.id}
              className={
                e.tone === 'ok'
                  ? 'text-emerald-800'
                  : e.tone === 'warn'
                    ? 'text-amber-800'
                    : 'text-red-800'
              }
            >
              {e.tone === 'ok' ? '✔ ' : e.tone === 'warn' ? '• ' : '✖ '}
              {e.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NoticeBox({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-testid="filling-notice"
      className={
        notice.tone === 'ok'
          ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-950'
          : notice.tone === 'warn'
            ? 'rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950'
            : 'rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900'
      }
    >
      <span aria-hidden="true">
        {notice.tone === 'ok' ? '✔ ' : notice.tone === 'warn' ? '• ' : '✖ '}
      </span>
      {notice.text}
    </div>
  );
}
