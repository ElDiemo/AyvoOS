import { API_BASE_PATH, healthResponseSchema, type HealthResponse } from '@ayvo/types';

export type ApiHealthResult =
  { reachable: true; health: HealthResponse } | { reachable: false; error: string };

/**
 * Calls the API health endpoint and validates the response against the shared contract.
 * `apiUrl` is the API origin; the absolute path replaces any path on it, so the `/api` prefix is
 * never duplicated.
 */
export async function fetchApiHealth(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiHealthResult> {
  try {
    const res = await fetchImpl(new URL(`${API_BASE_PATH}/health`, apiUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };

    const parsed = healthResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { reachable: false, error: 'Unexpected health response shape' };

    return { reachable: true, health: parsed.data };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
