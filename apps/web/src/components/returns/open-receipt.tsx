'use client';

import { returnReceiptDetailSchema, type ReturnHotelOption } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, inputClass } from '@/components/ui';
import { returnsCs } from '@/i18n/cs/returns';
import { apiSend } from '@/lib/client-api';
import { errorText, useStableRequests } from './stable-requests';

const t = returnsCs.open;

/** "Otevřít příjem": the hotel is chosen (or left unknown), never inferred from bottles. */
export function OpenReturnReceipt({ hotels }: { hotels: ReturnHotelOption[] }) {
  const router = useRouter();
  const send = useStableRequests();
  const [hotel, setHotel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const receipt = await send(`open:${hotel}`, (requestId) =>
        apiSend('POST', 'admin/returns/receipts', returnReceiptDetailSchema, {
          requestId,
          hotelCode: hotel || null,
        }),
      );
      router.push(`/warehouse/returns/${receipt.code}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span className="font-medium text-stone-700">{t.hotel}</span>
        <select
          className={inputClass}
          value={hotel}
          onChange={(e) => setHotel(e.target.value)}
          name="hotel"
        >
          <option value="">{t.noHotel}</option>
          {hotels.map((h) => (
            <option key={h.code} value={h.code}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={buttonClass.primary} disabled={busy}>
        {t.submit}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
