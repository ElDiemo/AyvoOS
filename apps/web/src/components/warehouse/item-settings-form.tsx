'use client';

import { inventoryItemSchema, type InventoryItem, type Supplier } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { apiErrorText } from './supplier-document-upload';

const s = warehouseCs.stock;

/** Appends a new version of an item's planning settings (never edits an old one). */
export function ItemSettingsForm({
  item,
  suppliers,
}: {
  item: InventoryItem;
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const current = item.settings;
  const [reorderPoint, setReorderPoint] = useState(current?.reorderPoint ?? '');
  const [targetLevel, setTargetLevel] = useState(current?.targetLevel ?? '');
  const [supplierId, setSupplierId] = useState(current?.preferredSupplier?.id ?? '');
  const [leadTime, setLeadTime] = useState(current?.leadTimeDays?.toString() ?? '');
  const [multiple, setMultiple] = useState(current?.purchaseMultiple ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-5"
      data-testid={`settings-${item.code}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
          await apiSend(
            'POST',
            `admin/inventory/items/${item.code}/settings`,
            inventoryItemSchema,
            {
              requestId: crypto.randomUUID(),
              reorderPoint: orNull(reorderPoint),
              targetLevel: orNull(targetLevel),
              preferredSupplierId: supplierId === '' ? null : supplierId,
              leadTimeDays: leadTime.trim() === '' ? null : Number(leadTime),
              purchaseMultiple: orNull(multiple),
            },
          );
          setMessage({ ok: true, text: s.settingsSaved });
          router.refresh();
        } catch (err) {
          setMessage({ ok: false, text: apiErrorText(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {s.reorderPoint}
        <input
          inputMode="decimal"
          value={reorderPoint}
          onChange={(e) => setReorderPoint(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.targetLevel}
        <input
          inputMode="decimal"
          value={targetLevel}
          onChange={(e) => setTargetLevel(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.preferredSupplier}
        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className={inputClass}
        >
          <option value="">{warehouseCs.common.none}</option>
          {suppliers.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.leadTime}
        <input
          inputMode="numeric"
          value={leadTime}
          onChange={(e) => setLeadTime(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.purchaseMultiple}
        <input
          inputMode="decimal"
          value={multiple}
          onChange={(e) => setMultiple(e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-5">
        <button type="submit" className={buttonClass.secondary} disabled={busy}>
          {warehouseCs.common.save}
        </button>
        {message &&
          (message.ok ? (
            <span className="text-sm text-emerald-800">{message.text}</span>
          ) : (
            <ErrorNote>{message.text}</ErrorNote>
          ))}
      </div>
    </form>
  );
}
