'use client';

import { stockIssueResultSchema, type InventoryItem, type InventoryLot } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { apiErrorText } from './supplier-document-upload';

const t = warehouseCs.issue;

/**
 * Issues a consumable (e.g. a printer ribbon roll) to consumption by hand (doc 018 §5a). It sends
 * the stock shown on this page: if it changed meanwhile nothing is issued (STOCK_CHANGED). One
 * attempt keeps one request id, so a repeated click never issues twice.
 */
export function StockIssueForm({
  item,
  onHand,
  lots,
}: {
  item: InventoryItem;
  onHand: string;
  lots: InventoryLot[];
}) {
  const router = useRouter();
  const unit = unitCs(item.unit.code);
  const [lotId, setLotId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = useAttempt();
  const lot = lots.find((l) => l.id === lotId) ?? null;
  const expectedOnHand = item.lotTracked ? (lot?.onHand ?? null) : onHand;
  if (!item.lotTracked && /^0(\.0+)?$/.test(onHand)) {
    return <p className="text-sm text-stone-500">{t.nothing}</p>;
  }
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-4"
      data-testid={`issue-${item.code}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (expectedOnHand === null) return;
        setError(null);
        setMessage(null);
        const body = {
          itemCode: item.code,
          lotId: item.lotTracked ? lotId : null,
          quantity: quantity.trim(),
          expectedOnHand,
          reason: reason.trim(),
        };
        const r = await attempt.run(JSON.stringify(body), (requestId) =>
          apiSend('POST', 'admin/inventory/issues', stockIssueResultSchema, {
            requestId,
            ...body,
          }),
        );
        if (r.ok) {
          setMessage(
            t.done(
              formatQuantityCs(r.value.quantity),
              unit,
              formatQuantityCs(r.value.balanceAfter),
            ),
          );
          setReason('');
          router.refresh();
        } else if (r.error) setError(apiErrorText(r.error));
      }}
    >
      {item.lotTracked && (
        <label className="flex flex-col gap-1 text-sm">
          {t.lot}
          <select
            required
            value={lotId}
            onChange={(e) => setLotId(e.target.value)}
            className={inputClass}
          >
            <option value="">{t.chooseLot}</option>
            {lots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} ({formatQuantityCs(l.onHand)} {unit})
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {t.quantity} ({unit})
        <input
          required
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className={inputClass}
          data-testid={`issue-${item.code}-quantity`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        {t.reason}
        <input
          required
          minLength={3}
          maxLength={500}
          value={reason}
          placeholder={t.reasonPlaceholder}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
          data-testid={`issue-${item.code}-reason`}
        />
      </label>
      <div className="sm:col-span-4 flex flex-col gap-2">
        {error && <ErrorNote>{error}</ErrorNote>}
        {message && (
          <p className="text-sm text-emerald-800" role="status">
            {message}
          </p>
        )}
        <div>
          <button
            type="submit"
            disabled={attempt.busy}
            className={buttonClass.primary}
            data-testid={`issue-${item.code}-submit`}
          >
            {attempt.busy ? t.submitting : t.submit}
          </button>
        </div>
      </div>
    </form>
  );
}
