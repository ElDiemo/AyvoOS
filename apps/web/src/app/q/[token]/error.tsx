'use client';

/** Public passport error boundary: a calm message, no technical details. */
export default function PassportError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-stone-100 px-6 text-center">
      <p className="text-2xl font-semibold tracking-[0.35em]">AYVO</p>
      <p className="text-sm text-stone-600">This bottle information is temporarily unavailable.</p>
      <button type="button" onClick={reset} className="text-sm underline">
        Try again
      </button>
    </main>
  );
}
