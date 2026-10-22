'use client';

import { itemBarcodesSchema, type ItemBarcodes as ItemBarcodesDto } from '@ayvo/types';
import { useId, useState } from 'react';
import {
  ConfirmDialog,
  fieldClass,
  FormField,
  reasonError,
  ReasonField,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { barcodeProblem, looksLikeLink } from './barcode-text';
import { apiErrorText } from './supplier-document-upload';

const b = warehouseCs.barcodes;

/** Czech text of a barcode refusal; a taken code names the item that holds it. */
export function barcodeErrorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code === 'BARCODE_TAKEN') {
    const item = (error.details as { item?: { code?: unknown; name?: unknown } } | null)?.item;
    if (typeof item?.name === 'string' && typeof item.code === 'string') {
      return `${warehouseCs.apiErrors.BARCODE_TAKEN} (${item.name}, ${item.code})`;
    }
  }
  return apiErrorText(error);
}

/**
 * Čárové kódy of one stock item (doc 033), loaded when opened. Everyone with inventory:read sees
 * them; assigning and retiring need inventory:barcodes_manage. A retired code stays in the
 * history; nothing here changes stock.
 */
export function ItemBarcodes({
  itemCode,
  canManage,
  tz,
}: {
  itemCode: string;
  canManage: boolean;
  tz: string;
}) {
  const id = useId();
  const [data, setData] = useState<ItemBarcodesDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<{ id: string; code: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const assign = useAttempt();
  const retire = useAttempt();

  async function load() {
    setLoadError(null);
    try {
      setData(await apiGet(`admin/inventory/items/${itemCode}/barcodes`, itemBarcodesSchema));
    } catch (e) {
      setLoadError(apiErrorText(e));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim();
    setNotice(null);
    const problem = looksLikeLink(value) ? b.invalid : barcodeProblem(value);
    if (problem) return setCodeError(looksLikeLink(value) ? warehouseCs.scan.looksLikeQr : problem);
    setCodeError(null);
    const result = await assign.run(value, (requestId) =>
      apiSend('POST', `admin/inventory/items/${itemCode}/barcodes`, itemBarcodesSchema, {
        requestId,
        code: value,
      }),
    );
    if (result.ok) {
      setData(result.value);
      setCode('');
      setNotice(b.assigned(value));
    } else if (result.error) setCodeError(barcodeErrorText(result.error));
  }

  async function confirmRetire() {
    if (!retiring) return;
    const invalid = reasonError(reason);
    setReasonErr(invalid);
    if (invalid) return;
    const result = await retire.run(`${retiring.id}:${reason}`, (requestId) =>
      apiSend('POST', `admin/inventory/barcodes/${retiring.id}/retire`, itemBarcodesSchema, {
        requestId,
        reason: reason.trim(),
      }),
    );
    if (result.ok) {
      setData(result.value);
      setRetiring(null);
      setReason('');
      setNotice(b.retired);
    } else if (result.error) setReasonErr(apiErrorText(result.error));
  }

  const active = data?.barcodes.filter((x) => !x.retiredAt) ?? [];
  const retired = data?.barcodes.filter((x) => x.retiredAt) ?? [];

  return (
    <details
      className="mt-4"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !data) void load();
      }}
      data-testid={`barcodes-${itemCode}`}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {b.title}
        {data ? ` (${active.length})` : ''}
      </summary>
      <div className="mt-3 flex flex-col gap-3 text-sm">
        <p className="text-stone-600">{b.help}</p>
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {data &&
          (active.length === 0 ? (
            <p className="text-stone-500">{b.none}</p>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
              {active.map((x) => (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  data-testid="barcode-active"
                >
                  <span className="min-w-0">
                    <span className="font-mono wrap-anywhere">{x.code}</span>
                    <span className="block text-xs text-stone-500">
                      {b.assignedAt(formatDateTimeCs(x.assignedAt, tz), x.assignedBy)}
                    </span>
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      className="text-sm text-red-700 underline"
                      onClick={() => {
                        setRetiring({ id: x.id, code: x.code });
                        setReason('');
                        setReasonErr(null);
                      }}
                    >
                      {b.retire}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
        {retired.length > 0 && (
          <details>
            <summary className="cursor-pointer text-stone-600">
              {b.showRetired(retired.length)}
            </summary>
            <ul className="mt-2 flex flex-col gap-2" data-testid="barcode-retired">
              {retired.map((x) => (
                <li key={x.id} className="text-stone-500">
                  <span className="font-mono line-through wrap-anywhere">{x.code}</span>
                  <span className="block text-xs">
                    {b.retiredAt(formatDateTimeCs(x.retiredAt!, tz), x.retiredBy ?? '—')} · „
                    {x.retireReason}“
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {notice && (
          <p role="status" className="text-emerald-800">
            {notice}
          </p>
        )}
        {canManage && data && (
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <FormField id={`${id}-code`} label={b.newCode} error={codeError}>
                <input
                  id={`${id}-code`}
                  value={code}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  aria-invalid={!!codeError}
                  aria-describedby={codeError ? `${id}-code-error` : undefined}
                  className={`${fieldClass(!!codeError)} font-mono`}
                />
              </FormField>
            </div>
            <button type="submit" className={buttonClass.secondary} disabled={assign.busy}>
              {b.assign}
            </button>
          </form>
        )}
      </div>
      <ConfirmDialog
        open={retiring !== null}
        title={retiring ? b.retireTitle(retiring.code) : ''}
        confirmLabel={b.retireConfirm}
        danger
        busy={retire.busy}
        onConfirm={() => void confirmRetire()}
        onCancel={() => setRetiring(null)}
        testId="retire-barcode-dialog"
      >
        <p>{b.retireText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={reasonErr} />
      </ConfirmDialog>
    </details>
  );
}
