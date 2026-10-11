'use client';

import { buttonClass, Card } from '@/components/ui';

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
      <h1 className="text-lg font-semibold">This page could not be loaded</h1>
      <p className="mt-2 text-sm text-stone-600">
        The AYVO OS API did not answer as expected. Nothing was changed. Try again; if it keeps
        failing, check the API status on the home page.
      </p>
      <button type="button" className={`${buttonClass.primary} mt-4`} onClick={reset}>
        Try again
      </button>
    </Card>
  );
}
