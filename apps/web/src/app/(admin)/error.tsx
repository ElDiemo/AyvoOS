'use client';

import { buttonClass, Card } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';

/**
 * Admin error boundary: API unreachable, timeouts or unexpected responses. Shows a safe message
 * only (never error details or stack traces) and lets the user retry.
 */
export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card>
      <h1 className="text-lg font-semibold">{shellCs.common.errorTitle}</h1>
      <p className="mt-2 text-sm text-stone-600">{shellCs.common.errorText}</p>
      <button type="button" className={`${buttonClass.primary} mt-4`} onClick={reset}>
        {shellCs.common.retry}
      </button>
    </Card>
  );
}
