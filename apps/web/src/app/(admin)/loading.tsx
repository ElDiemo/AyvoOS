/** Shown while a server-rendered admin page loads its data from the API. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className="h-8 w-56 animate-pulse rounded bg-stone-200" />
      <div className="h-40 animate-pulse rounded-lg bg-stone-100" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
