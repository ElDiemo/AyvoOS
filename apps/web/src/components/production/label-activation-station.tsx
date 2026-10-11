'use client';

import {
  inventoryLotSchema,
  labelApplicationResultSchema,
  type InventoryLot,
  type LabelApplicationResult,
  type RecentLabelApplication,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { formatDateTimeCs, formatQuantityCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { activeLot, activeSeries, type ActiveSeries } from '@/lib/session-choice';

const t = productionCs.labelActivation;
const lotsSchema = z.array(inventoryLotSchema);

type Outcome =
  | { kind: 'applied'; result: LabelApplicationResult }
  | { kind: 'already'; result: LabelApplicationResult }
  | { kind: 'rejected'; code: string }
  | { kind: 'exhausted' }
  | { kind: 'network'; scannedValue: string; requestId: string };

interface SessionEntry {
  id: number;
  tone: 'ok' | 'warn' | 'error';
  text: string;
  at: string;
}

const sectionTitle = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Physical label application (Production, doc 018 §7, doc 019): the operator selects the bottle
 * series being labelled and the source stock lot once per session, then scans each labelled
 * bottle. The server enforces both: a bottle of another series (WRONG_SERIES) or another lot's
 * stock is never used. Enter submits; the field clears and refocuses after every result. Every
 * scan carries a new request id; only "retry" after a network error reuses it, so a lost
 * response can never consume a second bottle.
 */
export function LabelActivationStation({
  initialLots,
  series,
  recent,
}: {
  initialLots: InventoryLot[];
  series: ActiveSeries[];
  recent: RecentLabelApplication[];
}) {
  const [lots, setLots] = useState(initialLots);
  const storedLot = useSyncExternalStore(activeLot.subscribe, activeLot.snapshot, () => null);
  const storedSeries = useSyncExternalStore(
    activeSeries.subscribe,
    activeSeries.snapshot,
    () => null,
  );
  const lot = useMemo(() => activeLot.parse(storedLot), [storedLot]);
  const selectedSeries = useMemo(() => activeSeries.parse(storedSeries), [storedSeries]);
  const lotOnHand = lot ? (lots.find((l) => l.id === lot.id)?.onHand ?? '0') : null;
  const exhausted = lotOnHand === '0';
  const ready = !!lot && !!selectedSeries;

  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A handheld scanner types into whatever has focus: keep the scan field focused whenever
  // scanning becomes possible (session restored after hydration, lot or series changed).
  useEffect(() => {
    if (ready && !exhausted) input.current?.focus();
  }, [ready, exhausted]);

  const log = (tone: SessionEntry['tone'], text: string) =>
    setEntries((list) =>
      [{ id: Date.now() + Math.random(), tone, text, at: new Date().toISOString() }, ...list].slice(
        0,
        20,
      ),
    );
  const refocus = () => requestAnimationFrame(() => input.current?.focus());

  async function refreshLots() {
    try {
      setLots(await apiGet('admin/inventory/lots?item=NEW_BOTTLE&available=false', lotsSchema));
    } catch {
      // keep the last known list; the next scan reports the real state
    }
  }

  async function submit(scannedValue: string, requestId = crypto.randomUUID()) {
    if (busy.current || !lot || !selectedSeries || scannedValue.trim() === '') return;
    busy.current = true;
    setChecking(true);
    try {
      const result = await apiSend(
        'POST',
        'admin/label-applications',
        labelApplicationResultSchema,
        { requestId, lotId: lot.id, seriesCode: selectedSeries.code, scannedValue },
      );
      setLots((list) =>
        list.map((l) =>
          l.id === result.selectedLot.id ? { ...l, onHand: result.selectedLot.onHand } : l,
        ),
      );
      if (result.outcome === 'APPLIED') {
        setOutcome({ kind: 'applied', result });
        log('ok', t.applied(result.bottle.code));
      } else {
        setOutcome({ kind: 'already', result });
        log('warn', t.alreadyApplied(result.bottle.code));
      }
    } catch (error) {
      if (error instanceof ClientApiError && error.code === 'LOT_EXHAUSTED') {
        setLots((list) => list.map((l) => (l.id === lot.id ? { ...l, onHand: '0' } : l)));
        setOutcome({ kind: 'exhausted' });
        log('error', t.lotExhaustedTitle);
      } else if (error instanceof ClientApiError && error.status < 500) {
        // Every 4xx is a definite answer (nothing was applied); unknown codes get a safe text.
        const code = error.code ?? 'UNKNOWN';
        setOutcome({ kind: 'rejected', code });
        log('error', (t.errors[code] ?? { title: productionCs.common.unexpectedError }).title);
      } else {
        setOutcome({ kind: 'network', scannedValue, requestId });
        log('error', productionCs.common.networkError);
      }
    } finally {
      busy.current = false;
      setChecking(false);
      setValue('');
      refocus();
    }
  }

  if (!ready) {
    return (
      <SessionSetup
        lots={lots}
        series={series}
        selectedSeries={selectedSeries}
        onSeries={(s) => {
          activeSeries.set(s);
          setOutcome(null);
        }}
        onLot={(l) => {
          activeLot.set({ id: l.id, code: l.code });
          setOutcome(null);
          refocus();
        }}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-stone-300 bg-white sm:grid-cols-2">
          <ContextCell
            testId="active-series"
            title={t.series}
            code={selectedSeries.code}
            detail={selectedSeries.label}
            action={t.changeSeries}
            onChange={() => {
              activeSeries.set(null);
              setOutcome(null);
            }}
          />
          <ContextCell
            testId="active-lot"
            title={t.lot}
            code={lot.code}
            detail={
              <span data-testid="active-lot-remaining" className="tabular-nums">
                {t.remaining(formatQuantityCs(lotOnHand ?? '0'))}
              </span>
            }
            action={t.changeLot}
            alert={exhausted}
            className="border-t border-stone-200 sm:border-t-0 sm:border-l"
            onChange={() => {
              activeLot.set(null);
              setOutcome(null);
              void refreshLots();
            }}
          />
        </div>

        {exhausted ? (
          <div
            role="alert"
            className="rounded-lg border-2 border-red-500 bg-red-50 p-5 text-red-900"
          >
            <p className="text-xl font-semibold">{t.lotExhaustedTitle}</p>
            <p className="mt-1">{t.lotExhausted}</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(value);
            }}
            className="flex flex-col gap-2"
          >
            <label htmlFor="scan" className="text-sm font-medium text-stone-800">
              {t.scanLabel}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="scan"
                ref={input}
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                value={value}
                disabled={checking}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t.scanPlaceholder}
                className={cn(inputClass, 'min-h-14 min-w-0 flex-1 font-mono text-lg')}
                data-testid="scan-input"
              />
              <button
                type="submit"
                disabled={checking || value.trim() === ''}
                className={cn(
                  buttonClass.primary,
                  'min-h-14 shrink-0 px-8 text-base whitespace-nowrap',
                )}
                data-testid="scan-submit"
              >
                {checking ? t.checking : t.submit}
              </button>
            </div>
          </form>
        )}

        <ScanOutcome
          outcome={outcome}
          checking={checking}
          onRetry={(o) => void submit(o.scannedValue, o.requestId)}
        />
      </div>

      <section className="min-w-0">
        <h2 className={sectionTitle}>{t.sessionResults}</h2>
        <p className="mb-2 text-xs text-stone-400">{t.sessionHelp}</p>
        {entries.length === 0 ? (
          <p className="text-sm text-stone-500">{t.noResults}</p>
        ) : (
          <ol className="flex flex-col gap-1" data-testid="session-results">
            {entries.map((e) => (
              <li
                key={e.id}
                className={cn(
                  'flex flex-wrap justify-between gap-x-3 rounded-md px-3 py-2 text-sm',
                  e.tone === 'ok' && 'bg-emerald-50 text-emerald-900',
                  e.tone === 'warn' && 'bg-amber-50 text-amber-900',
                  e.tone === 'error' && 'bg-red-50 text-red-900',
                )}
              >
                <span className="min-w-0 wrap-anywhere">{e.text}</span>
                <span className="shrink-0 tabular-nums text-stone-500">
                  {formatDateTimeCs(e.at)}
                </span>
              </li>
            ))}
          </ol>
        )}
        {recent.length > 0 && entries.length === 0 && (
          <>
            <h3 className={cn(sectionTitle, 'mt-6 mb-2')}>{t.recentElsewhere}</h3>
            <ul className="flex flex-col gap-1 text-xs text-stone-500">
              {recent.slice(0, 5).map((r) => (
                <li key={`${r.bottleCode}-${r.appliedAt}`} className="wrap-anywhere">
                  <span className="font-mono text-stone-700">{r.bottleCode}</span> · {r.lotCode} ·{' '}
                  {formatDateTimeCs(r.appliedAt)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function ContextCell({
  testId,
  title,
  code,
  detail,
  action,
  onChange,
  alert = false,
  className,
}: {
  testId: string;
  title: string;
  code: string;
  detail: React.ReactNode;
  action: string;
  onChange: () => void;
  alert?: boolean;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start justify-between gap-3 p-4',
        alert ? 'bg-red-50' : 'bg-white',
        className,
      )}
    >
      <div className="min-w-0">
        <p className={sectionTitle}>{title}</p>
        <p className="font-mono text-xl font-semibold wrap-anywhere">{code}</p>
        <p className="text-sm text-stone-600 wrap-anywhere">{detail}</p>
      </div>
      <button
        type="button"
        className={cn(buttonClass.secondary, 'shrink-0 px-3 whitespace-nowrap')}
        onClick={onChange}
      >
        {action}
      </button>
    </div>
  );
}

function SessionSetup({
  lots,
  series,
  selectedSeries,
  onSeries,
  onLot,
}: {
  lots: InventoryLot[];
  series: ActiveSeries[];
  selectedSeries: ActiveSeries | null;
  onSeries: (s: ActiveSeries) => void;
  onLot: (l: InventoryLot) => void;
}) {
  const [lotCode, setLotCode] = useState('');
  const [lotError, setLotError] = useState<string | null>(null);
  const available = lots.filter((l) => l.onHand !== '0');
  const choice =
    'flex w-full items-center justify-between gap-3 rounded-md border border-stone-300 bg-white px-4 py-3 text-left transition hover:border-stone-900 focus-visible:border-stone-900';

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t.setupTitle}</h2>
      <p className="mt-1 text-sm text-stone-600">{t.setupHelp}</p>
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <h3 className={sectionTitle}>{t.seriesStep}</h3>
          <p className="mt-1 mb-3 text-xs text-stone-500">{t.seriesHelp}</p>
          {selectedSeries ? (
            <div
              className="rounded-md border-2 border-stone-900 px-4 py-3"
              data-testid="active-series"
            >
              <p className="font-mono font-semibold">{selectedSeries.code}</p>
              <p className="text-sm text-stone-600 wrap-anywhere">{selectedSeries.label}</p>
            </div>
          ) : series.length === 0 ? (
            <p
              className="rounded-md bg-amber-50 p-4 text-sm text-amber-900"
              data-testid="no-series"
            >
              {t.noSeries}
            </p>
          ) : (
            <ul
              className="flex max-h-80 flex-col gap-2 overflow-y-auto"
              data-testid="series-choices"
            >
              {series.map((s) => (
                <li key={s.code}>
                  <button type="button" className={choice} onClick={() => onSeries(s)}>
                    <span className="min-w-0">
                      <span className="block font-mono font-semibold">{s.code}</span>
                      <span className="block text-sm text-stone-600 wrap-anywhere">{s.label}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0">
          <h3 className={sectionTitle}>{t.lotStep}</h3>
          <p className="mt-1 mb-3 text-xs text-stone-500">{t.lotHelp}</p>
          {available.length === 0 ? (
            <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900" data-testid="no-lots">
              {t.noLots}
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" data-testid="lot-choices">
              {available.map((l) => (
                <li key={l.id}>
                  <button type="button" className={choice} onClick={() => onLot(l)}>
                    <span className="min-w-0">
                      <span className="block font-mono font-semibold wrap-anywhere">{l.code}</span>
                      <span className="block text-sm text-stone-600 wrap-anywhere">
                        {warehouseCs.stock.lotKind[l.kind]}
                        {l.supplier ? ` · ${l.supplier.name}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-lg font-semibold tabular-nums">
                      {formatQuantityCs(l.onHand)} {warehouseCs.common.pcs}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              // Lot codes are unique per supplier only: never guess between several matches.
              const matches = available.filter((l) => l.code === lotCode.trim());
              if (matches.length === 1) onLot(matches[0]!);
              else setLotError(matches.length > 1 ? t.ambiguousLot : t.unknownLot);
            }}
          >
            <input
              value={lotCode}
              onChange={(e) => setLotCode(e.target.value)}
              placeholder={t.lotCodePlaceholder}
              aria-label={t.lotCodePlaceholder}
              className={cn(inputClass, 'min-w-0 flex-1')}
            />
            <button
              type="submit"
              className={cn(buttonClass.secondary, 'shrink-0 whitespace-nowrap')}
            >
              {t.useLot}
            </button>
          </form>
          {lotError && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {lotError}
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}

function ScanOutcome({
  outcome,
  checking,
  onRetry,
}: {
  outcome: Outcome | null;
  checking: boolean;
  onRetry: (o: Extract<Outcome, { kind: 'network' }>) => void;
}) {
  const box = 'rounded-lg border-2 p-5';
  if (checking) {
    return (
      <div role="status" className={cn(box, 'border-stone-300 bg-stone-50 text-lg')}>
        {t.checking}
      </div>
    );
  }
  if (!outcome || outcome.kind === 'exhausted') {
    return outcome ? null : (
      <div role="status" className={cn(box, 'border-dashed border-stone-300 text-stone-500')}>
        {t.ready}
      </div>
    );
  }
  if (outcome.kind === 'applied') {
    const r = outcome.result;
    return (
      <div
        role="status"
        data-testid="scan-outcome"
        className={cn(box, 'border-emerald-600 bg-emerald-50 text-emerald-950')}
      >
        <p className="text-2xl font-semibold wrap-anywhere">{t.applied(r.bottle.code)}</p>
        <p className="mt-1 text-lg">
          {t.appliedDetail(r.consumedLot.code, formatQuantityCs(r.selectedLot.onHand))}
        </p>
        <p className="mt-1 text-sm">{productionCs.bottleStatus.LABELED_EMPTY}</p>
      </div>
    );
  }
  if (outcome.kind === 'already') {
    const r = outcome.result;
    return (
      <div
        role="status"
        data-testid="scan-outcome"
        className={cn(box, 'border-amber-500 bg-amber-50 text-amber-950')}
      >
        <p className="text-2xl font-semibold wrap-anywhere">{t.alreadyApplied(r.bottle.code)}</p>
        <p className="mt-1 text-lg">
          {t.alreadyAppliedDetail(formatDateTimeCs(r.bottle.labelAppliedAt))}
        </p>
      </div>
    );
  }
  if (outcome.kind === 'rejected') {
    const message = t.errors[outcome.code] ?? {
      title: productionCs.common.unexpectedError,
      action: '',
    };
    return (
      <div
        role="alert"
        data-testid="scan-outcome"
        className={cn(box, 'border-red-600 bg-red-50 text-red-950')}
      >
        <p className="text-2xl font-semibold">{message.title}</p>
        {message.action && <p className="mt-1 text-lg">{message.action}</p>}
      </div>
    );
  }
  return (
    <div
      role="alert"
      data-testid="scan-outcome"
      className={cn(box, 'flex flex-col gap-3 border-red-600 bg-red-50 text-red-950')}
    >
      <p className="text-lg">{productionCs.common.networkError}</p>
      <button
        type="button"
        className={cn(buttonClass.primary, 'min-h-12 self-start px-6 whitespace-nowrap')}
        onClick={() => onRetry(outcome)}
      >
        {warehouseCs.common.retry}
      </button>
    </div>
  );
}
