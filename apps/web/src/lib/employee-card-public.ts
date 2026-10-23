import 'server-only';
import { headers } from 'next/headers';
import { serverEnv } from './env';

/** Anonymous SSR never forwards a session or Authorization; no cached personal-data response. */
export async function fetchEmployeeCard(path: string) {
  const incoming = await headers();
  const forwarded = incoming.get('x-forwarded-for');
  return fetch(new URL(`/api/public/employee-cards/${path}`, serverEnv.API_URL), {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  });
}
