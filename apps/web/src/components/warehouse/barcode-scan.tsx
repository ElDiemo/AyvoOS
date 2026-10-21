'use client';

import {
  barcodeLookupSchema,
  itemBarcodesSchema,
  RECEIPT_LINES_MAX,
  type InventoryItem,
  type ItemRef,
} from '@ayvo/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, inputClass } from '@/components/ui';
import { unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet, apiSend } from '@/lib/client-api';
import { barcodeProblem, looksLikeLink } from './barcode-text';
import { barcodeErrorText } from './item-barcodes';

const t = warehouseCs.scan;

/** Keystrokes closer than this belong to one scanner burst (people type far slower). */
const BURST_GAP_MS = 50;
const BURST_MIN_CHARS = 4;

/**
 * A scanner read typed into another field (e.g. a quantity the operator just entered): a fast
 * burst of characters ended by Enter. The field gets its value from before the burst back and
 * the code goes to the scan instead (review 033-1); slow, human typing is never affected.
 */
export function useScannerBurst() {
  const burst = useRef<{ start: string; chars: string; last: number } | null>(null);
  return (
    e: React.KeyboardEvent<HTMLInputElement>,
    onScan: (code: string, restore: string) => void,
  ) => {
    const now = e.timeStamp;
    const b = burst.current;
    if (e.key === 'Enter') {
      burst.current = null;
      if (b && b.chars.length >= BURST_MIN_CHARS && now - b.last <= BURST_GAP_MS) {
        e.preventDefault();
        onScan(b.chars, b.start);
      }
      return;
    }
    if (e.key.length !== 1) return;
    if (!b || now - b.last > BURST_GAP_MS) {
      burst.current = { start: e.currentTarget.value, chars: e.key, last: now };
    } else {
      b.chars += e.key;
      b.last = now;
    }
  };
}

export type ScannedItem = Pick<ItemRef, 'id' | 'code' | 'name' | 'unit'>;
export type ScanOutcome = { line: number; added: boolean } | { full: true } | { ignored: true };

type Message =
  | { tone: 'ok'; text: string; detail: string }
  | { tone: 'warn'; text: string; detail?: string; unknown?: string };

/**
 * "Načíst kód zboží" (doc 033). A keyboard-wedge scanner types the code and Enter: Enter here only
 * looks the code up (it never submits the receipt), and the lookup only selects the item — the
 * receipt, quantity, supplier, lot and document stay explicit. Scans are handled one after another
 * in the order they were read. On any failure the form stays as it was and the focus returns here.
 */
export function BarcodeScan({
  items,
  canManage,
  onItem,
  handleRef,
}: {
  items: InventoryItem[];
  canManage: boolean;
  onItem: (item: ScannedItem) => ScanOutcome;
  /** Lets the form pass on a scan that landed in another field (useScannerBurst). */
  handleRef?: React.RefObject<((code: string) => void) | null>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const [assignItem, setAssignItem] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [refocus, setRefocus] = useState(0);
  const assign = useAttempt();
  useEffect(() => {
    if (refocus > 0) input.current?.focus();
  }, [refocus]);

  const back = (code?: string) => {
    if (code !== undefined) setValue((v) => (v === '' ? code : v));
    setRefocus((n) => n + 1);
  };

  function applyItem(item: ScannedItem) {
    const outcome = onItem(item);
    if ('ignored' in outcome) return;
    if ('full' in outcome) {
      setMessage({ tone: 'warn', text: t.linesFull(RECEIPT_LINES_MAX) });
      return back();
    }
    setMessage({
      tone: 'ok',
      text: t.found(item.name, item.code, unitCs(item.unit.code)),
      detail: outcome.added ? t.addedLine(outcome.line) : t.alreadyOnLine(outcome.line),
    });
  }

  async function resolve(code: string) {
    setAssignError(null);
    if (looksLikeLink(code)) {
      setMessage({ tone: 'warn', text: t.looksLikeQr });
      return back();
    }
    const problem = barcodeProblem(code);
    if (problem) {
      setMessage({ tone: 'warn', text: problem });
      return back();
    }
    let found;
    try {
      found = await apiGet(
        `admin/inventory/barcodes/lookup?code=${encodeURIComponent(code)}`,
        barcodeLookupSchema,
      );
    } catch {
      setMessage({ tone: 'warn', text: t.failed, detail: code });
      return back(code);
    }
    if (!found.item) {
      setMessage(
        found.retired
          ? { tone: 'warn', text: t.retired(code) }
          : {
              tone: 'warn',
              text: t.unknown(code),
              detail: canManage ? t.unknownNextManager : t.unknownNextOther,
              unknown: code,
            },
      );
      setAssignItem('');
      setAssignError(null);
      return back();
    }
    if (found.item.archived || !items.some((i) => i.id === found.item!.id)) {
      setMessage({ tone: 'warn', text: t.notAvailable(found.item.name) });
      return back();
    }
    applyItem(found.item);
  }

  function enqueue(code: string) {
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(() => resolve(code))
      // One failed scan never stops the ones read after it (review 033-5).
      .catch(() => back(code))
      .finally(() => setPending((n) => n - 1));
  }
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = (code) => {
      enqueue(code);
      setRefocus((n) => n + 1);
    };
    return () => {
      handleRef.current = null;
    };
  });

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    // The scanner's Enter must never submit or confirm anything else on the page.
    e.preventDefault();
    e.stopPropagation();
    const code = value.trim();
    if (!code) return;
    setValue('');
    enqueue(code);
  }

  async function assignUnknown(code: string) {
    const item = items.find((i) => i.id === assignItem);
    if (!item) return;
    setAssignError(null);
    const result = await assign.run(`${code}:${item.code}`, (requestId) =>
      apiSend('POST', `admin/inventory/items/${item.code}/barcodes`, itemBarcodesSchema, {
        requestId,
        code,
      }),
    );
    if (result.ok) {
      applyItem(item);
    } else if (result.error) {
      setAssignError(barcodeErrorText(result.error));
      back();
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-sky-200 bg-sky-50 p-4"
      data-testid="barcode-scan"
    >
      <label htmlFor={`${id}-scan`} className="text-sm font-semibold text-sky-950">
        {t.label}
      </label>
      <input
        ref={input}
        id={`${id}-scan`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-describedby={`${id}-scan-help ${id}-scan-result`}
        className={`${inputClass} font-mono`}
      />
      <p id={`${id}-scan-help`} className="text-xs text-sky-900">
        {t.help}
      </p>
      <div id={`${id}-scan-result`} role="status" aria-live="polite" data-testid="scan-result">
        {pending > 0 && <p className="text-sm text-stone-600">{t.looking}</p>}
        {pending === 0 && message && (
          <div
            className={
              message.tone === 'ok'
                ? 'rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900'
                : 'rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900'
            }
            data-tone={message.tone}
          >
            <p className="font-medium wrap-anywhere">{message.text}</p>
            {message.detail && <p className="wrap-anywhere">{message.detail}</p>}
          </div>
        )}
      </div>
      {pending === 0 && message?.tone === 'warn' && message.unknown && canManage && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="scan-assign">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            {t.assignTo}
            <select
              value={assignItem}
              onChange={(e) => setAssignItem(e.target.value)}
              className={inputClass}
            >
              <option value="">{t.assignChoose}</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.code})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={!assignItem || assign.busy}
            onClick={() => void assignUnknown(message.unknown!)}
          >
            {t.assignSubmit}
          </button>
        </div>
      )}
      {assignError && <p className="text-sm text-red-700">{assignError}</p>}
    </div>
  );
}
