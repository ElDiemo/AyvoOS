'use client';

import { financeCs } from '@/i18n/cs/finance';

/**
 * Finance runs as its own unit (ADR 0039): when it (or the core it asks) is unavailable, only the
 * Finance pages say so — the rest of AYVO OS keeps working.
 */
export default function FinanceError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-xl font-semibold">{financeCs.unavailable.title}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{financeCs.unavailable.text}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md border px-4 py-2 text-sm font-medium"
      >
        {financeCs.unavailable.retry}
      </button>
    </div>
  );
}
