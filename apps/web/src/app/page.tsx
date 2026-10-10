import { StatusBadge } from '@ayvo/ui';
import { fetchApiHealth } from '@/lib/api-health';
import { serverEnv } from '@/lib/env';

// Always render at request time so the API status is live.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const result = await fetchApiHealth(serverEnv.API_URL);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">AYVO OS</h1>
        <p className="text-stone-600">
          Operating system for AYVO circular hotel amenities. Foundation phase — no business modules
          yet.
        </p>
      </header>

      <section
        data-testid="api-status"
        className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm"
      >
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-stone-500">
          System status
        </h2>
        {result.reachable ? (
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
            <dt>API</dt>
            <dd>
              <StatusBadge tone={result.health.status === 'ok' ? 'ok' : 'warning'}>
                {result.health.status}
              </StatusBadge>
            </dd>
            <dt>PostgreSQL</dt>
            <dd>
              <StatusBadge tone={result.health.checks.database === 'up' ? 'ok' : 'error'}>
                {result.health.checks.database}
              </StatusBadge>
            </dd>
            <dt>Redis</dt>
            <dd>
              <StatusBadge tone={result.health.checks.redis === 'up' ? 'ok' : 'error'}>
                {result.health.checks.redis}
              </StatusBadge>
            </dd>
            <dt>Environment</dt>
            <dd className="font-mono text-xs">{result.health.environment}</dd>
          </dl>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <StatusBadge tone="error">API unreachable</StatusBadge>
            <span className="text-stone-500">{result.error}</span>
          </div>
        )}
      </section>
    </main>
  );
}
