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
import { warehouseCs } from '@/i18n/cs/warehouse';
import {
  activeLotSnapshot,
  parseActiveLot,
  setActiveLot,
  subscribeActiveLot,
} from '@/lib/active-lot';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';

const t = warehouseCs.labels;
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

/**
 * Physical label application (doc 018 §7, §10): select the session's source lot once, then scan
 * each labelled bottle. Enter submits; the field clears and refocuses after every result. Every
 * scan carries a new request id; only "retry" after a network error reuses it, so a lost
 * response can never consume a second bottle.
 */
export function LabelApplicationStation({
  initialLots,
  recent,
}: {
  initialLots: InventoryLot[];
  recent: RecentLabelApplication[];
}) {
  const [lots, setLots] = useState(initialLots);
  const stored = useSyncExternalStore(subscribeActiveLot, activeLotSnapshot, () => null);
  const active = useMemo(() => parseActiveLot(stored), [stored]);
  const activeOnHand = active ? (lots.find((l) => l.id === active.id)?.onHand ?? '0') : null;
  const exhausted = activeOnHand === '0';

  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [lotCode, setLotCode] = useState('');
  const [lotError, setLotError] = useState<string | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A handheld scanner types into whatever has focus: keep the scan field focused whenever
  // scanning becomes possible (lot restored after hydration, lot changed, lot replenished).
  useEffect(() => {
    if (active && !exhausted) input.current?.focus();
  }, [active, exhausted]);

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
    if (busy.current || !active || scannedValue.trim() === '') return;
    busy.current = true;
    setChecking(true);
    try {
      const result = await apiSend(
        'POST',
        'admin/label-applications',
        labelApplicationResultSchema,
        {
          requestId,
          lotId: active.id,
          scannedValue,
        },
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
        setLots((list) => list.map((l) => (l.id === active.id ? { ...l, onHand: '0' } : l)));
        setOutcome({ kind: 'exhausted' });
        log('error', t.lotExhaustedTitle);
      } else if (error instanceof ClientApiError && error.code && error.status < 500) {
        setOutcome({ kind: 'rejected', code: error.code });
        log('error', (t.errors[error.code] ?? { title: warehouseCs.common.unexpectedError }).title);
      } else {
        setOutcome({ kind: 'network', scannedValue, requestId });
        log('error', warehouseCs.common.networkError);
      }
    } finally {
      busy.current = false;
      setChecking(false);
      setValue('');
      refocus();
    }
  }

  function selectLot(lot: InventoryLot) {
    setActiveLot({ id: lot.id, code: lot.code });
    setOutcome(null);
    setLotError(null);
    refocus();
  }

  if (!active) {
    const available = lots.filter((l) => l.onHand !== '0');
    return (
      <Card>
        <h2 className="text-lg font-semibold">{t.chooseLot}</h2>
        <p className="mt-1 text-sm text-stone-600">{t.chooseLotHelp}</p>
        {available.length === 0 ? (
          <p className="mt-6 rounded-md bg-amber-50 p-4 text-amber-900" data-testid="no-lots">
            {t.noLots}
          </p>
        ) : (
          <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="lot-choices">
            {available.map((lot) => (
              <li key={lot.id}>
                <button
                  type="button"
                  onClick={() => selectLot(lot)}
                  className="w-full rounded-lg border-2 border-stone-300 bg-white p-4 text-left transition hover:border-stone-900 focus:border-stone-900 focus:outline-none"
                >
                  <span className="block font-mono text-lg font-semibold wrap-anywhere">
                    {lot.code}
                  </span>
                  <span className="block text-sm text-stone-600">
                    {warehouseCs.stock.lotKind[lot.kind]}
                    {lot.supplier ? ` · ${lot.supplier.name}` : ''}
                  </span>
                  <span className="mt-2 block text-2xl font-semibold tabular-nums">
                    {formatQuantityCs(lot.onHand)} {warehouseCs.common.pcs}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-6 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            // Lot codes are unique per supplier only: never guess between several matches.
            const matches = available.filter((l) => l.code === lotCode.trim());
            if (matches.length === 1) selectLot(matches[0]!);
            else setLotError(matches.length > 1 ? t.ambiguousLot : t.unknownLot);
          }}
        >
          <input
            value={lotCode}
            onChange={(e) => setLotCode(e.target.value)}
            placeholder={t.lotCodePlaceholder}
            aria-label={t.lotCodePlaceholder}
            className={cn(inputClass, 'text-base')}
          />
          <button type="submit" className={buttonClass.secondary}>
            {t.useLot}
          </button>
        </form>
        {lotError && <p className="mt-2 text-sm text-red-700">{lotError}</p>}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        className={cn(
          'flex flex-col gap-3 rounded-lg border-2 p-4 sm:flex-row sm:items-center sm:justify-between',
          exhausted ? 'border-red-400 bg-red-50' : 'border-stone-900 bg-white',
        )}
        data-testid="active-lot"
      >
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            {t.activeLot}
          </p>
          <p className="font-mono text-2xl font-semibold wrap-anywhere">{active.code}</p>
          <p className="text-lg tabular-nums" data-testid="active-lot-remaining">
            {t.remaining(formatQuantityCs(activeOnHand ?? '0'))}
          </p>
        </div>
        <button
          type="button"
          className={cn(buttonClass.secondary, 'min-h-12 px-6 text-base')}
          onClick={() => {
            setActiveLot(null);
            setOutcome(null);
            void refreshLots();
          }}
        >
          {t.changeLot}
        </button>
      </div>

      {exhausted ? (
        <div role="alert" className="rounded-lg border-2 border-red-400 bg-red-50 p-6 text-red-900">
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
          <label htmlFor="scan" className="text-sm font-medium text-stone-700">
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
              className={cn(inputClass, 'min-h-14 font-mono text-lg')}
              data-testid="scan-input"
            />
            <button
              type="submit"
              disabled={checking || value.trim() === ''}
              className={cn(buttonClass.primary, 'min-h-14 px-8 text-base')}
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

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-stone-500">
          {t.sessionResults}
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-stone-500">{t.noResults}</p>
        ) : (
          <ol className="flex flex-col gap-1" data-testid="session-results">
            {entries.map((e) => (
              <li
                key={e.id}
                className={cn(
                  'flex justify-between gap-4 rounded-md px-3 py-2 text-sm',
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
          <p className="mt-2 text-xs text-stone-500">
            {recent
              .slice(0, 5)
              .map((r) => `${r.bottleCode} (${r.lotCode})`)
              .join(' · ')}
          </p>
        )}
      </section>
    </div>
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
  if (checking) {
    return (
      <div role="status" className="rounded-lg border-2 border-stone-300 bg-stone-50 p-6 text-lg">
        {t.checking}
      </div>
    );
  }
  if (!outcome || outcome.kind === 'exhausted') {
    return outcome ? null : (
      <div
        role="status"
        className="rounded-lg border-2 border-dashed border-stone-300 p-6 text-stone-500"
      >
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
        className="rounded-lg border-2 border-emerald-500 bg-emerald-50 p-6 text-emerald-900"
      >
        <p className="text-2xl font-semibold wrap-anywhere">{t.applied(r.bottle.code)}</p>
        <p className="mt-1 text-lg">
          {t.appliedDetail(r.consumedLot.code, formatQuantityCs(r.selectedLot.onHand))}
        </p>
        <p className="mt-1 text-sm">{warehouseCs.bottleStatus.LABELED_EMPTY}</p>
      </div>
    );
  }
  if (outcome.kind === 'already') {
    const r = outcome.result;
    return (
      <div
        role="status"
        data-testid="scan-outcome"
        className="rounded-lg border-2 border-amber-500 bg-amber-50 p-6 text-amber-900"
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
      title: warehouseCs.common.unexpectedError,
      action: '',
    };
    return (
      <div
        role="alert"
        data-testid="scan-outcome"
        className="rounded-lg border-2 border-red-500 bg-red-50 p-6 text-red-900"
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
      className="flex flex-col gap-3 rounded-lg border-2 border-red-500 bg-red-50 p-6 text-red-900"
    >
      <p className="text-lg">{warehouseCs.common.networkError}</p>
      <button
        type="button"
        className={cn(buttonClass.primary, 'min-h-12 self-start px-6')}
        onClick={() => onRetry(outcome)}
      >
        {warehouseCs.common.retry}
      </button>
    </div>
  );
}
