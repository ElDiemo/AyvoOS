'use client';

import { useId, useState } from 'react';
import { inputClass } from './ui';

/**
 * Numeric input that lets the user type freely and commits on blur/Enter (so intermediate values
 * like "4" on the way to "48" are not clamped away). Shows the committed value otherwise.
 */
export function NumberField({
  label,
  value,
  onCommit,
  step = 0.1,
  unit = 'mm',
  disabled,
  testId,
  hint,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  unit?: string;
  disabled?: boolean;
  testId?: string;
  hint?: string;
}) {
  const id = useId();
  // While editing, show the user's draft; otherwise always the committed value.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const parsed = Number((draft ?? '').replace(',', '.'));
    if (draft !== null && draft.trim() !== '' && Number.isFinite(parsed)) onCommit(parsed);
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-stone-500">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          data-testid={testId}
          type="number"
          inputMode="decimal"
          step={step}
          value={draft ?? String(value)}
          disabled={disabled}
          onFocus={() => setDraft(String(value))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className={`${inputClass} pr-10 tabular-nums`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-stone-400">
          {unit}
        </span>
      </div>
      {hint && <p className="text-xs text-stone-400">{hint}</p>}
    </div>
  );
}
