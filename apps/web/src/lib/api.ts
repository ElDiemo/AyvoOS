import 'server-only';
import { API_BASE_PATH } from '@ayvo/types';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { serverEnv } from './env';
import { safeNextPath } from './safe-path';

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
  return safeNextPath(path);
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
  if (
    code === 'SITE_REQUIRED' ||
    code === 'SITE_WITHOUT_WAREHOUSE' ||
    code === 'SITE_WITHOUT_PRODUCTION'
  ) {
    // Choose (another) site, then come back.
    const next = encodeURIComponent(await currentPath());
    const reason =
      code === 'SITE_WITHOUT_WAREHOUSE'
        ? '&reason=no-warehouse'
        : code === 'SITE_WITHOUT_PRODUCTION'
          ? '&reason=no-production'
          : '';
    redirect(`/select-site?next=${next}${reason}`);
  }
  redirect('/forbidden');
}

/** Finance routes are served by the Finance unit (ADR 0039); everything else by the core API. */
export function apiOrigin(path: string): string {
  const finance = /^\/?admin\/finance(\/|$)/.test(path);
  if (!finance) return serverEnv.API_URL;
  if (!serverEnv.FINANCE_API_URL) throw new ApiError(503, 'Finance je dočasně nedostupné.');
  return serverEnv.FINANCE_API_URL;
}

async function call(path: string, query?: Record<string, string | number | undefined>) {
  const url = new URL(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, apiOrigin(path));
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
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string };
    if (body.code === 'SITE_WITHOUT_WAREHOUSE' || body.code === 'SITE_WITHOUT_PRODUCTION') {
      return redirectForAuth(409, body.code);
    }
  }
  if (res.status === 404) notFound();
  if (!res.ok) throw new ApiError(res.status, `API ${res.status} for ${path}`);
  return schema.parse(await res.json());
}

/**
 * Anonymous GET of a public route (QR pages): null for 404, never a sign-in redirect. No session
 * travels with it. The edge's X-Forwarded-For is passed on, so the API's per-visitor rate limit
 * sees the visitor and not this server (the API trusts it only from TRUSTED_PROXY_CIDRS; doc 037).
 */
export async function apiGetPublic<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  const forwardedFor = (await headers()).get('x-forwarded-for');
  const res = await fetch(
    new URL(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, serverEnv.API_URL),
    {
      cache: 'no-store',
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (res.status === 404) return null;
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
