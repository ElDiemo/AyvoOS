'use client';

import {
  goodsReceiptSchema,
  RECEIPT_LINES_MAX,
  type InventoryItem,
  type Supplier,
  type SupplierDocument,
} from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { buttonClass, Card, ErrorNote, Field, FieldList, inputClass } from '@/components/ui';
import { formatDateCs, formatDateTimeCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { BarcodeScan, useScannerBurst, type ScannedItem, type ScanOutcome } from './barcode-scan';
import { apiErrorText, SupplierDocumentUpload } from './supplier-document-upload';

const r = warehouseCs.receipts;
const QUANTITY = /^(0|[1-9]\d{0,15})(\.\d{1,3})?$/;

interface Line {
  key: number;
  itemId: string;
  /** The item was only preset (first item / empty), not chosen: a scan may fill this line. */
  preset: boolean;
  quantity: string;
  supplierLotCode: string;
  unitPrice: string;
  currency: string;
  vatRate: string;
}

/** An untouched line a scanned item may fill instead of adding another line. */
const freeForScan = (l: Line) =>
  l.preset &&
  l.quantity === '' &&
  l.supplierLotCode === '' &&
  l.unitPrice === '' &&
  l.vatRate === '';

function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Receiving workflow (doc 018 §10): supplier → reference and date → documents (invoice or
 * delivery note required) → lines → review → confirm once. The request id is created at review
 * and reused for every retry of that confirmation.
 */
export function GoodsReceiptForm({
  suppliers,
  items,
  canWriteCosts,
  canManageBarcodes = false,
  initialItemId,
}: {
  suppliers: Supplier[];
  items: InventoryItem[];
  /** inventory:barcodes_manage: an unknown scanned code may be assigned to an item right here. */
  canManageBarcodes?: boolean;
  /**
   * The first line's item: undefined = the first item (as before); an id = that item (e.g. the
   * material of a recipe from "Připravit výrobu"); null = none, the user chooses.
   */
  initialItemId?: string | null;
  /** Prices are recorded only with procurement:cost_write (the API refuses them otherwise). */
  canWriteCosts: boolean;
}) {
  const router = useRouter();
  const formId = useId();
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(localNow);
  const [note, setNote] = useState('');
  const [documents, setDocuments] = useState<SupplierDocument[]>([]);
  const [lines, setLines] = useState<Line[]>([
    {
      key: 1,
      itemId: initialItemId === undefined ? (items[0]?.id ?? '') : (initialItemId ?? ''),
      // An item preselected from "Připravit výrobu" was chosen deliberately: a scan never replaces it.
      preset: typeof initialItemId !== 'string',
      quantity: '',
      supplierLotCode: '',
      unitPrice: '',
      currency: 'CZK',
      vatRate: '',
    },
  ]);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest lines for scans resolved in quick succession (before React re-renders).
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  // The line a scan selected: highlighted, while the focus stays in the scan field — a
  // keyboard-wedge scanner types wherever the focus is, so a next scan must never land in a
  // quantity (review 033-1).
  const [scannedLine, setScannedLine] = useState<number | null>(null);
  useEffect(() => {
    if (scannedLine !== null)
      document
        .getElementById(`${formId}-line-${scannedLine}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [scannedLine, formId]);
  const scanHandle = useRef<((code: string) => void) | null>(null);
  const quantityBurst = useScannerBurst();
  const nextKey = useRef(2);
  const newKey = () => nextKey.current++;
  // A lookup still in flight when the receipt goes to review changes nothing (review 033-2).
  const reviewingRef = useRef(false);
  useEffect(() => {
    reviewingRef.current = requestId !== null;
  }, [requestId]);

  if (suppliers.length === 0) {
    return (
      <Card>
        <p className="text-stone-700">
          {r.noSuppliers}{' '}
          <Link href="/warehouse/suppliers" className="font-medium underline">
            {warehouseCs.suppliers.title}
          </Link>
        </p>
      </Card>
    );
  }

  const itemOf = (id: string) => items.find((i) => i.id === id);
  const hasRequiredDocument = documents.some(
    (d) => d.kind === 'INVOICE' || d.kind === 'DELIVERY_NOTE',
  );
  const linesValid = lines.every((l) => {
    const item = itemOf(l.itemId);
    if (!item || !QUANTITY.test(l.quantity) || /^0(\.0+)?$/.test(l.quantity)) return false;
    if (item.unit.decimalPlaces === 0 && l.quantity.includes('.')) return false;
    return l.unitPrice === '' || QUANTITY.test(l.unitPrice);
  });
  const canReview =
    supplierId !== '' && reference.trim() !== '' && hasRequiredDocument && linesValid;
  const reviewing = requestId !== null;
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch, preset: false } : l)));

  /**
   * A scanned item (doc 033): already on a line → that line, nothing added or changed; else the
   * first untouched preset line, else a new line. Quantity, lot and price stay empty — the
   * operator enters them; a scan never receives anything.
   */
  function applyScanned(item: ScannedItem): ScanOutcome {
    if (reviewingRef.current) return { ignored: true };
    const current = linesRef.current;
    // A line the operator chose or filled; an untouched preset line is simply taken over.
    const existing = current.findIndex((l) => l.itemId === item.id && !freeForScan(l));
    if (existing >= 0) {
      setScannedLine(current[existing]!.key);
      return { line: existing + 1, added: false };
    }
    const free = current.findIndex(freeForScan);
    let next: Line[];
    let index: number;
    if (free >= 0) {
      index = free;
      next = current.map((l, i) => (i === free ? { ...l, itemId: item.id, preset: false } : l));
    } else {
      if (current.length >= RECEIPT_LINES_MAX) return { full: true };
      index = current.length;
      next = [
        ...current,
        {
          key: newKey(),
          itemId: item.id,
          preset: false,
          quantity: '',
          supplierLotCode: '',
          unitPrice: '',
          currency: 'CZK',
          vatRate: '',
        },
      ];
    }
    linesRef.current = next;
    setLines(next);
    setScannedLine(next[index]!.key);
    return { line: index + 1, added: true };
  }

  async function confirm() {
    if (!requestId) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await apiSend('POST', 'admin/goods-receipts', goodsReceiptSchema, {
        requestId,
        supplierId,
        supplierReference: reference.trim(),
        receivedAt: new Date(receivedAt).toISOString(),
        note: note.trim() === '' ? null : note.trim(),
        documentIds: documents.map((d) => d.id),
        lines: lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          supplierLotCode: l.supplierLotCode.trim() === '' ? null : l.supplierLotCode.trim(),
          unitPrice: !canWriteCosts || l.unitPrice === '' ? null : l.unitPrice,
          currency: !canWriteCosts || l.unitPrice === '' ? null : l.currency,
          vatRate: !canWriteCosts || l.unitPrice === '' || l.vatRate === '' ? null : l.vatRate,
        })),
      });
      router.push(`/warehouse/receipts/${receipt.code}?created=1`);
    } catch (e) {
      setError(apiErrorText(e));
      setBusy(false);
    }
  }

  const supplier = suppliers.find((s) => s.id === supplierId);

  return (
    <div className="flex flex-col gap-6">
      <Card title={`1 · ${r.supplier}`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {r.supplier}
            <select
              value={supplierId}
              disabled={reviewing || documents.length > 0}
              onChange={(e) => setSupplierId(e.target.value)}
              className={inputClass}
            >
              <option value="">{r.chooseSupplier}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {r.reference}
            <input
              value={reference}
              disabled={reviewing}
              onChange={(e) => setReference(e.target.value)}
              maxLength={64}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {r.receivedAt}
            <input
              type="datetime-local"
              value={receivedAt}
              disabled={reviewing}
              onChange={(e) => setReceivedAt(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {r.note}
            <input
              value={note}
              disabled={reviewing}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className={inputClass}
            />
          </label>
        </div>
      </Card>

      <Card title={`2 · ${r.stepDocuments}`}>
        <p className="mb-4 text-sm text-stone-600">{r.documentsHelp}</p>
        {documents.length > 0 && (
          <ul className="mb-4 flex flex-col gap-1 text-sm" data-testid="receipt-documents">
            {documents.map((d) => (
              <li key={d.id} className="wrap-anywhere">
                {warehouseCs.documents.kinds[d.kind]} {d.documentNumber} ·{' '}
                {formatDateCs(d.issuedOn)} · {d.originalFilename}
              </li>
            ))}
          </ul>
        )}
        {!supplierId && !reviewing && (
          <p className="text-sm text-stone-600" data-testid="document-needs-supplier">
            {r.chooseSupplierFirst}
          </p>
        )}
        {supplierId && !reviewing && (
          <SupplierDocumentUpload
            supplierId={supplierId}
            onUploaded={(doc) => setDocuments((ds) => [...ds, doc])}
          />
        )}
        {!hasRequiredDocument && (
          <p className="mt-2 text-sm text-amber-800">{r.documentRequired}</p>
        )}
      </Card>

      <Card title={`3 · ${r.stepLines}`}>
        <div className="flex flex-col gap-4">
          {!reviewing && (
            <BarcodeScan
              items={items}
              canManage={canManageBarcodes}
              onItem={applyScanned}
              handleRef={scanHandle}
            />
          )}
          {lines.map((line, index) => {
            const item = itemOf(line.itemId);
            return (
              <div
                key={line.key}
                id={`${formId}-line-${line.key}`}
                className={`grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-3 ${
                  scannedLine === line.key
                    ? 'border-sky-400 ring-2 ring-sky-100'
                    : 'border-stone-200'
                }`}
                data-scanned={scannedLine === line.key || undefined}
                data-testid={`receipt-line-${index + 1}`}
              >
                <label className="flex flex-col gap-1 text-sm">
                  {r.item}
                  <select
                    value={line.itemId}
                    disabled={reviewing}
                    onChange={(e) => update(line.key, { itemId: e.target.value })}
                    className={inputClass}
                  >
                    {line.itemId === '' && <option value="">{r.chooseItem}</option>}
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.code})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  {r.quantity} {item ? `(${unitCs(item.unit.code)})` : ''}
                  <input
                    inputMode="decimal"
                    value={line.quantity}
                    disabled={reviewing}
                    onChange={(e) => update(line.key, { quantity: e.target.value.trim() })}
                    onKeyDown={(e) =>
                      quantityBurst(e, (code, restore) => {
                        update(line.key, { quantity: restore.trim() });
                        scanHandle.current?.(code);
                      })
                    }
                    className={inputClass}
                  />
                </label>
                {item?.lotTracked && (
                  <label className="flex flex-col gap-1 text-sm">
                    {r.supplierLot}
                    <input
                      value={line.supplierLotCode}
                      disabled={reviewing}
                      onChange={(e) => update(line.key, { supplierLotCode: e.target.value })}
                      maxLength={64}
                      className={inputClass}
                    />
                    <span className="text-xs text-stone-500">{r.supplierLotHelp}</span>
                  </label>
                )}
                {canWriteCosts && (
                  <details className="sm:col-span-3">
                    <summary className="cursor-pointer text-sm text-stone-600">{r.price}</summary>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <input
                        inputMode="decimal"
                        aria-label={r.price}
                        value={line.unitPrice}
                        disabled={reviewing}
                        onChange={(e) => update(line.key, { unitPrice: e.target.value.trim() })}
                        className={inputClass}
                      />
                      <input
                        aria-label={r.currency}
                        value={line.currency}
                        disabled={reviewing}
                        maxLength={3}
                        onChange={(e) =>
                          update(line.key, { currency: e.target.value.toUpperCase() })
                        }
                        className={inputClass}
                      />
                      <input
                        inputMode="decimal"
                        aria-label={r.vat}
                        placeholder={r.vat}
                        value={line.vatRate}
                        disabled={reviewing}
                        onChange={(e) => update(line.key, { vatRate: e.target.value.trim() })}
                        className={inputClass}
                      />
                    </div>
                  </details>
                )}
                {lines.length > 1 && !reviewing && (
                  <button
                    type="button"
                    className="justify-self-start text-sm text-red-700 underline"
                    onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                  >
                    {r.removeLine}
                  </button>
                )}
              </div>
            );
          })}
          {!reviewing && (
            <button
              type="button"
              className={`${buttonClass.secondary} self-start`}
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  {
                    key: newKey(),
                    itemId: items[0]?.id ?? '',
                    preset: true,
                    quantity: '',
                    supplierLotCode: '',
                    unitPrice: '',
                    currency: 'CZK',
                    vatRate: '',
                  },
                ])
              }
            >
              {r.addLine}
            </button>
          )}
        </div>
      </Card>

      {!reviewing ? (
        <div>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!canReview}
            onClick={() => setRequestId(crypto.randomUUID())}
          >
            {r.review}
          </button>
        </div>
      ) : (
        <Card title={r.reviewTitle}>
          <div data-testid="receipt-review">
            <FieldList>
              <Field label={r.supplier}>{supplier?.name}</Field>
              <Field label={r.reference}>{reference}</Field>
              <Field label={r.receivedAt}>
                {formatDateTimeCs(new Date(receivedAt).toISOString())}
              </Field>
              <Field label={r.documents}>
                {documents
                  .map((d) => `${warehouseCs.documents.kinds[d.kind]} ${d.documentNumber}`)
                  .join(', ')}
                {!documents.some((d) => d.kind === 'INVOICE') && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                    {r.invoicePending}
                  </span>
                )}
              </Field>
              {lines.map((l) => {
                const item = itemOf(l.itemId)!;
                return (
                  <Field key={l.key} label={item.name}>
                    {formatQuantityCs(l.quantity)} {unitCs(item.unit.code)}
                    {item.lotTracked &&
                      ` · ${r.lot}: ${l.supplierLotCode.trim() || r.supplierLotHelp}`}
                  </Field>
                );
              })}
            </FieldList>
          </div>
          {error && (
            <div className="mt-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? r.confirming : r.confirm}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={() => {
                setRequestId(null);
                setError(null);
              }}
            >
              {r.edit}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
