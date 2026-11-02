'use client';

import { inputClass } from '@/components/ui';
import { billingCs } from '@/i18n/cs/finance-billing';
import { CURRENCY_SUGGESTIONS } from '@/lib/country-options';

/** A suggestion, not a rule: any valid three-letter code stays possible, and what the API refuses it says. */
export function CurrencyInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {billingCs.fields.currency}
      <input
        name="currency"
        required
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        list="currency-suggestions"
        maxLength={3}
        pattern="[A-Z]{3}"
        autoComplete="off"
        className={inputClass}
      />
      <datalist id="currency-suggestions">
        {CURRENCY_SUGGESTIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </label>
  );
}
