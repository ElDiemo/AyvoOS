'use client';

import type { SalesIndicativePrice } from '@ayvo/types';
import { useId, useState } from 'react';
import { fieldClass, FormField } from '@/components/catalog/form-kit';
import { Card } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { cents, formatCents } from './sales-money';

const c = salesCs.calculator;

/**
 * "Orientační kalkulace" on a prospect (doc 060 §D): rooms × the indicative price per room and
 * month the sales manager set, per currency, monthly and yearly — exact, labelled indicative and
 * never an offer. Without a price nothing is computed (no default is ever assumed).
 */
export function PriceCalculator({
  prices,
  rooms,
}: {
  prices: SalesIndicativePrice[];
  rooms: number | null;
}) {
  const id = useId();
  const [value, setValue] = useState(rooms?.toString() ?? '');
  const [copied, setCopied] = useState<string | null>(null);
  const n = /^\d{1,6}$/.test(value.trim()) ? BigInt(value.trim()) : null;
  return (
    <Card title={c.title} testId="price-calculator">
      {prices.length === 0 ? (
        <p className="text-sm text-stone-600" data-testid="calculator-no-price">
          {c.noPrice}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField id={`${id}-rooms`} label={c.rooms}>
            <input
              id={`${id}-rooms`}
              inputMode="numeric"
              maxLength={6}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={fieldClass(false)}
              data-testid="calculator-rooms"
            />
          </FormField>
          {prices.map((p) => {
            const monthly = n !== null && n > 0n ? n * cents(p.amount) : null;
            const text = monthly
              ? c.copyText(
                  value.trim(),
                  `${formatCents(cents(p.amount))} ${p.currency}`,
                  `${formatCents(monthly)} ${p.currency}`,
                  `${formatCents(monthly * 12n)} ${p.currency}`,
                  p.note,
                )
              : null;
            return (
              <div
                key={p.currency}
                className="flex flex-col gap-1 rounded-md border border-stone-200 p-3 text-sm"
                data-testid={`calculator-${p.currency}`}
              >
                <p className="text-stone-600">
                  {c.price(`${formatCents(cents(p.amount))} ${p.currency}`)} · {p.note}
                </p>
                {monthly ? (
                  <>
                    <p>
                      {c.monthly}:{' '}
                      <strong data-testid={`calculator-monthly-${p.currency}`}>
                        {formatCents(monthly)} {p.currency}
                      </strong>
                    </p>
                    <p>
                      {c.yearly}:{' '}
                      <strong data-testid={`calculator-yearly-${p.currency}`}>
                        {formatCents(monthly * 12n)} {p.currency}
                      </strong>
                    </p>
                    <button
                      type="button"
                      className="self-start text-xs underline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(text!);
                          setCopied(p.currency);
                        } catch {
                          setCopied(null);
                        }
                      }}
                      data-testid={`calculator-copy-${p.currency}`}
                    >
                      {copied === p.currency ? c.copied : c.copy}
                    </button>
                  </>
                ) : (
                  <p className="text-stone-500">{c.enterRooms}</p>
                )}
              </div>
            );
          })}
          <p className="text-xs text-stone-500">{c.disclaimer}</p>
        </div>
      )}
    </Card>
  );
}
