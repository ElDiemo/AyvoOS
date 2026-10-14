'use client';

import {
  labelingOptionsSchema,
  labelingStateSchema,
  labelScanResultSchema,
  type LabelingOptions,
  type LabelingState,
} from '@ayvo/types';
import { useEffect, useId, useRef, useState } from 'react';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { labelingCs } from '@/i18n/cs/labeling';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { scanFeedback } from '@/lib/scan-feedback';

const t = labelingCs;
type Notice = { tone: 'ok' | 'warn' | 'error'; text: string; retry?: () => void } | null;

const uncertain = (error: unknown) => !(error instanceof ClientApiError) || error.status >= 500;

function errorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && t.errors[error.code]) return t.errors[error.code]!;
    if (error.status === 403) return t.errors.FORBIDDEN!;
    if (error.status < 500) return t.failed;
  }
  return t.network;
}

/**
 * The labelling station's work (doc 025 A3): choose once product, approved design and bottle lot,
 * load a crate, then scan each bottle AFTER its label is applied ("Potvrdit nalepení"): the
 * bottle goes into the crate and the body and label are consumed once. The server re-validates
 * everything on every scan. Uncertain answers keep their request id, so a retry is replayed by
 * the server and never consumes twice; one scan field at a time keeps the scanner's focus.
 */
export function LabelingWorkspace({
  sessionId,
  onUnresolvedChange,
}: {
  sessionId: string;
  /** True while scans wait or an uncertain one is unresolved: the station must not be left. */
  onUnresolvedChange?: (unresolved: boolean) => void;
}) {
  const id = useId();
  const base = `admin/station-sessions/${sessionId}`;
  const [state, setState] = useState<LabelingState | null>(null);
  const [options, setOptions] = useState<LabelingOptions | null>(null);
  const [editing, setEditing] = useState(false);
  const [product, setProduct] = useState('');
  const [design, setDesign] = useState('');
  const [lot, setLot] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [log, setLog] = useState<{ id: number; tone: string; text: string }[]>([]);
  const attempts = useRef(new Map<string, string>());
  const input = useRef<HTMLInputElement>(null);

  const attemptId = (key: string) => {
    const existing = attempts.current.get(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    attempts.current.set(key, fresh);
    return fresh;
  };

  // The server's state and the choices of this station, loaded once per session.
  useEffect(() => {
    let alive = true;
    Promise.all([
      apiGet(`${base}/labeling`, labelingStateSchema),
      apiGet(`${base}/labeling-options`, labelingOptionsSchema),
    ])
      .then(([s, o]) => {
        if (!alive) return;
        setState(s);
        setOptions(o);
        if (!s.product) setEditing(true);
      })
      .catch((error: unknown) => {
        if (alive) setNotice({ tone: 'error', text: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [base]);

  const contextReady = !!state?.product && !!state.design && !!state.sourceLot && !editing;
  const crateAssembling =
    !!state?.crate && (!state.crate.cycle || state.crate.cycle.status === 'OPEN_ASSEMBLY');
  const phase: 'context' | 'crate' | 'bottle' = !contextReady
    ? 'context'
    : crateAssembling
      ? 'bottle'
      : 'crate';

  // The scanner types into whatever has focus: keep the active scan field focused.
  useEffect(() => {
    if (phase !== 'context') input.current?.focus();
  }, [phase, notice]);

  const push = (tone: string, text: string) =>
    setLog((l) => [{ id: Date.now() + Math.random(), tone, text }, ...l].slice(0, 15));

  async function applyContext() {
    if (!product || !design || !lot || busy) return;
    const body = { productCode: product, labelTemplateVersionId: design, sourceLotId: lot };
    const key = `context:${JSON.stringify(body)}`;
    setBusy(true);
    try {
      const s = await apiSend('POST', `${base}/labeling-context`, labelingStateSchema, {
        requestId: attemptId(key),
        ...body,
      });
      attempts.current.delete(key);
      setState(s);
      setEditing(false);
      setNotice(null);
    } catch (error) {
      if (!uncertain(error)) attempts.current.delete(key);
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  // Scanner series (issue #19: "rychlá série"): the field never blocks; every scan is queued
  // with the kind and the context revision it had when scanned, and sent in order. An UNCERTAIN
  // answer (network, 5xx) stops the queue: that scan stays visible with its request id until it
  // is retried (the server replays a committed one, never consumes twice); later scans wait,
  // visibly, and the context, the crate and the station cannot be changed meanwhile.
  type Item = { kind: 'crate' | 'scan'; raw: string; revision: number; requestId: string };
  const queue = useRef<Item[]>([]);
  const draining = useRef(false);
  const blockedRef = useRef(false);
  const [waiting, setWaiting] = useState(0);
  const [blocked, setBlocked] = useState<Item | null>(null);
  const stateRef = useRef<LabelingState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const unresolved = waiting > 0 || blocked !== null;
  useEffect(() => {
    onUnresolvedChange?.(unresolved);
    if (!unresolved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unresolved, onUnresolvedChange]);

  function submit(raw: string) {
    if (raw.trim() === '') return;
    queue.current.push({
      kind: phase === 'crate' ? 'crate' : 'scan',
      raw,
      revision: stateRef.current?.contextRevision ?? 0,
      requestId: crypto.randomUUID(),
    });
    setWaiting(queue.current.length);
    setValue('');
    if (!draining.current && !blockedRef.current) void drain();
  }

  async function drain() {
    draining.current = true;
    setBusy(true);
    try {
      while (queue.current.length > 0 && !blockedRef.current) {
        const item = queue.current[0]!;
        const definite = await process(item);
        if (!definite) {
          blockedRef.current = true;
          setBlocked(item);
          break;
        }
        queue.current.shift();
        setWaiting(queue.current.length);
      }
    } finally {
      draining.current = false;
      setBusy(false);
      setWaiting(queue.current.length);
    }
  }

  /** Retries the SAME uncertain scan (same request id and context revision), then continues. */
  function retryBlocked() {
    blockedRef.current = false;
    setBlocked(null);
    if (!draining.current) void drain();
  }

  /** Sends one scan; false = no definite answer (the queue stops on it). */
  async function process(item: Item): Promise<boolean> {
    const { kind, raw } = item;
    try {
      if (kind === 'crate') {
        const s = await apiSend('POST', `${base}/crate`, labelingStateSchema, {
          requestId: item.requestId,
          scannedValue: raw,
        });
        setState(s);
        setNotice({ tone: 'ok', text: t.crate.loaded(s.crate!.code) });
        scanFeedback('ok');
      } else {
        const r = await apiSend('POST', `${base}/label-scans`, labelScanResultSchema, {
          requestId: item.requestId,
          scannedValue: raw,
          contextRevision: item.revision,
        });
        setState((s) =>
          s
            ? {
                ...s,
                sourceLot: s.sourceLot
                  ? { ...s.sourceLot, onHand: r.sourceLot.onHand }
                  : s.sourceLot,
                crate: s.crate ? { ...s.crate, cycle: r.cycle } : s.crate,
              }
            : s,
        );
        const text =
          r.outcome === 'APPLIED'
            ? t.scan.applied(r.bottle.code, r.cycle.memberCount, r.cycle.capacity)
            : t.scan.already(r.bottle.code);
        const full = r.cycle.status === 'READY_TO_FILL';
        setNotice({
          tone: r.outcome === 'APPLIED' ? 'ok' : 'warn',
          text: full ? `${text} ${t.crate.full(r.crate.code)}` : text,
        });
        push(r.outcome === 'APPLIED' ? 'ok' : 'warn', text);
        scanFeedback(r.outcome === 'APPLIED' ? 'ok' : 'error');
      }
      return true;
    } catch (error) {
      scanFeedback('error');
      if (uncertain(error)) {
        push('error', t.scan.uncertainLog);
        return false;
      }
      const text = errorText(error);
      setNotice({ tone: 'error', text });
      push('error', text);
      return true;
    }
  }

  if (!state || !options) return notice ? <NoticeBox notice={notice} busy={busy} /> : null;

  const chosen = options.products.find((p) => p.code === product);
  const lots = chosen ? options.lots.filter((l) => l.itemCode === chosen.bottleItem.code) : [];
  const cycle = state.crate?.cycle ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="labeling">
      <Card title={t.context.title}>
        {contextReady ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium" data-testid="labeling-context">
              {t.context.current(state.product!.name, state.design!.label, state.sourceLot!.code)}
              <span className="block text-xs text-stone-500">
                {t.context.recipe(cycle?.recipeVersion ?? state.recipeVersion!)} ·{' '}
                {t.scan.lotLeft(state.sourceLot!.code, state.sourceLot!.onHand)}
              </span>
            </p>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={unresolved}
              onClick={() => {
                setProduct(
                  options.products.find((p) => p.code === state.product!.code)?.code ?? '',
                );
                setDesign(state.design!.versionId);
                setLot(state.sourceLot!.id);
                setEditing(true);
              }}
            >
              {t.context.change}
            </button>
          </div>
        ) : options.products.length === 0 ? (
          <p className="text-sm text-stone-700">{t.context.noProducts}</p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="labeling-context-form">
            <p className="text-xs text-stone-500">{t.context.help}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-p`}>
                {t.context.product}
                <select
                  id={`${id}-p`}
                  value={product}
                  onChange={(e) => {
                    setProduct(e.target.value);
                    setDesign('');
                    setLot('');
                  }}
                  className={inputClass}
                >
                  <option value="">{t.context.choose}</option>
                  {options.products.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} ({p.code})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-d`}>
                {t.context.design}
                <select
                  id={`${id}-d`}
                  value={design}
                  disabled={!chosen || chosen.designs.length === 0}
                  onChange={(e) => setDesign(e.target.value)}
                  className={inputClass}
                >
                  <option value="">{t.context.choose}</option>
                  {chosen?.designs.map((d) => (
                    <option key={d.versionId} value={d.versionId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-l`}>
                {t.context.lot}
                <select
                  id={`${id}-l`}
                  value={lot}
                  disabled={!chosen || lots.length === 0}
                  onChange={(e) => setLot(e.target.value)}
                  className={inputClass}
                >
                  <option value="">{t.context.choose}</option>
                  {lots.map((l) => (
                    <option key={l.id} value={l.id}>
                      {t.context.lotOption(l.code, l.onHand)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {chosen && chosen.designs.length === 0 && (
              <p className="text-sm text-amber-900">{t.context.noDesign}</p>
            )}
            {chosen && lots.length === 0 && (
              <p className="text-sm text-amber-900">{t.context.noLot}</p>
            )}
            {chosen && (
              <p className="text-xs text-stone-500">{t.context.recipe(chosen.recipeVersion)}</p>
            )}
            <div>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={busy || !product || !design || !lot}
                onClick={() => void applyContext()}
              >
                {t.context.apply}
              </button>
            </div>
          </div>
        )}
      </Card>

      {contextReady && (
        <div
          className="grid grid-cols-2 gap-3 rounded-lg border border-stone-300 bg-white p-4 sm:grid-cols-[1fr_auto_auto]"
          data-testid="labeling-crate"
        >
          <p className="col-span-2 text-sm sm:col-span-1">
            <span className="block text-xs uppercase tracking-wide text-stone-500">
              {t.crate.title}
            </span>
            <span className="font-mono text-lg font-semibold">{state.crate?.code ?? '—'}</span>
            {state.crate && !cycle && (
              <span className="block text-xs text-stone-500">{t.crate.newCycle}</span>
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
            <span className="text-2xl font-bold tabular-nums text-stone-500">
              0/{state.crate?.capacity ?? '—'}
            </span>
          </p>
        </div>
      )}

      {phase !== 'context' && (
        <Card>
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
              {busy ? t.scan.checking : phase === 'crate' ? t.crate.help : t.scan.help}
            </p>
          </form>
          {phase === 'bottle' && (
            <button
              type="button"
              className={`${buttonClass.secondary} mt-3`}
              disabled={unresolved}
              onClick={() => setState((s) => (s ? { ...s, crate: null } : s))}
            >
              {t.crate.change}
            </button>
          )}
        </Card>
      )}
      {unresolved && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm text-red-950"
          data-testid="labeling-unresolved"
        >
          {blocked && (
            <>
              <p className="font-semibold">{t.scan.blockedTitle}</p>
              <p>{t.scan.blockedText}</p>
            </>
          )}
          <p data-testid="labeling-waiting">
            {t.scan.waiting(Math.max(0, waiting - (blocked ? 1 : 0)))}
          </p>
          {blocked && (
            <button
              type="button"
              className={`${buttonClass.primary} self-start`}
              onClick={retryBlocked}
            >
              {t.scan.retry}
            </button>
          )}
        </div>
      )}
      {notice && <NoticeBox notice={notice} busy={busy} />}
      {log.length > 0 && (
        <ol className="flex flex-col gap-1 text-sm" data-testid="labeling-log">
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

function NoticeBox({ notice, busy }: { notice: NonNullable<Notice>; busy: boolean }) {
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-testid="labeling-notice"
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
      {notice.retry && (
        <button
          type="button"
          className={`${buttonClass.secondary} ml-2`}
          onClick={notice.retry}
          disabled={busy}
        >
          {t.scan.retry}
        </button>
      )}
    </div>
  );
}
