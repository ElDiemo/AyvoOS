import 'server-only';
import { API_BASE_PATH } from '@ayvo/types';
import { notFound } from 'next/navigation';
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

/**
 * Server-side GET against the API (API_URL, internal network), validated with the shared
 * contract. A 404 renders the Next.js not-found page.
 */
export async function apiGet<T extends z.ZodType>(
  path: string,
  schema: T,
  query?: Record<string, string | number | undefined>,
): Promise<z.infer<T>> {
  const url = new URL(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, serverEnv.API_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) notFound();
  if (!res.ok) throw new ApiError(res.status, `API ${res.status} for ${path}`);
  return schema.parse(await res.json());
}
