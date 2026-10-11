import 'server-only';
import { API_BASE_PATH } from '@ayvo/types';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { serverEnv } from './env';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = 'ayvo_session';

/** The page the browser asked for (set by src/proxy.ts), for "back to where you were" redirects. */
export async function currentPath(): Promise<string> {
  const path = (await headers()).get('x-ayvo-path');
  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

/** Only the AYVO session cookie is forwarded to the API — identity never travels in headers. */
async function sessionHeader(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { cookie: `${SESSION_COOKIE}=${token}` } : {};
}

/** Sends the browser to the page that matches an authentication or authorization refusal. */
export async function redirectForAuth(status: number, code: string | undefined): Promise<never> {
  if (status === 401) {
    const next = encodeURIComponent(await currentPath());
    redirect(code === 'SESSION_EXPIRED' ? `/session-expired?next=${next}` : `/login?next=${next}`);
  }
  if (code === 'ACCOUNT_INACTIVE') redirect('/account-inactive');
  redirect('/forbidden');
}

async function call(path: string, query?: Record<string, string | number | undefined>) {
  const url = new URL(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, serverEnv.API_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return fetch(url, {
    cache: 'no-store',
    headers: await sessionHeader(),
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Server-side GET against the API (API_URL, internal network) with the user's session, validated
 * with the shared contract. 401/403 lead to the sign-in, session-expired, account-inactive or
 * forbidden page; a 404 renders the Next.js not-found page.
 */
export async function apiGet<T extends z.ZodType>(
  path: string,
  schema: T,
  query?: Record<string, string | number | undefined>,
): Promise<z.infer<T>> {
  const res = await call(path, query);
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return redirectForAuth(res.status, body.code);
  }
  if (res.status === 404) notFound();
  if (!res.ok) throw new ApiError(res.status, `API ${res.status} for ${path}`);
  return schema.parse(await res.json());
}

/** Like apiGet, but answers null instead of redirecting when there is no valid session. */
export async function apiGetOptional<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  const res = await call(path);
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new ApiError(res.status, `API ${res.status} for ${path}`);
  return schema.parse(await res.json());
}
