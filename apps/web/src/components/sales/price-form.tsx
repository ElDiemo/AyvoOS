'use client';

import { salesIndicativePricesSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { fieldClass, FormField, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiSend } from '@/lib/client-api';
import { salesErrorText } from './sales-format';

const t = salesCs.prices;

/** A new version of the indicative price (sales:manage); one request id per attempt. */
export function PriceForm() {
  const id = useId();
  const router = useRouter();
  const { busy, run } = useAttempt();
  const [currency, setCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="price-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const body = {
          currency: currency.trim().toUpperCase(),
          amount: amount.trim().replace(',', '.'),
          note: note.trim(),
        };
        if (
          !/^[A-Z]{3}$/.test(body.currency) ||
          !/^\d{1,10}(\.\d{1,2})?$/.test(body.amount) ||
          !/[1-9]/.test(body.amount) ||
          !body.note
        )
          return setError(t.invalid);
        const result = await run(JSON.stringify(body), (requestId) =>
          apiSend('POST', 'admin/sales/indicative-prices', salesIndicativePricesSchema, {
            requestId,
            ...body,
          }),
        );
        if (result.ok) {
          setAmount('');
          setNote('');
          router.refresh();
        } else if (result.error) setError(salesErrorText(result.error));
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_12rem_1fr]">
        <FormField id={`${id}-cur`} label={t.currency}>
          <input
            id={`${id}-cur`}
            maxLength={3}
            placeholder="CZK"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={fieldClass(false)}
            data-testid="price-currency"
          />
        </FormField>
        <FormField id={`${id}-amount`} label={t.amount} help={t.amountHelp}>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            maxLength={13}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={fieldClass(false)}
            data-testid="price-amount"
          />
        </FormField>
        <FormField id={`${id}-note`} label={t.note} help={t.noteHelp}>
          <input
            id={`${id}-note`}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={fieldClass(false)}
            data-testid="price-note"
          />
        </FormField>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700" data-testid="price-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${buttonClass.primary} self-start`}>
        {t.save}
      </button>
    </form>
  );
}
