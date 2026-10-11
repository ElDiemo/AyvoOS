/**
 * Skeleton shown while a server-rendered admin page loads its data from the API (used by the
 * `loading.tsx` of list and create pages).
 *
 * Not used above detail pages on purpose: a loading boundary starts streaming the response with
 * HTTP 200 before the page has run, so an unknown code could no longer answer with a real 404.
 */
export function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className="h-8 w-56 animate-pulse rounded bg-stone-200" />
      <div className="h-40 animate-pulse rounded-lg bg-stone-100" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
