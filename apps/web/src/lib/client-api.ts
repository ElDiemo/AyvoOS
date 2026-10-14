import { API_BASE_PATH } from '@ayvo/types';
import type { z } from 'zod';

/** Browser-side calls to the same-origin API (/api/admin/...). */
export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Stable domain error code from the API (e.g. "LOT_EXHAUSTED"), if any. */
    readonly code: string | null = null,
    /** Whitelisted details of some refusals (e.g. who holds a station); validate before use. */
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ClientApiError> {
  let message = `Požadavek se nezdařil (HTTP ${res.status})`;
  let code: string | null = null;
  let details: unknown = null;
  try {
    const body = (await res.json()) as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
      issues?: { path: string; message: string }[];
    };
    if (typeof body.code === 'string') code = body.code;
    details = body.details ?? null;
    if (body.issues?.length) {
      message = body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // non-JSON error body: keep the generic message
  }
  if (res.status === 413) message = 'Soubor je příliš velký';
  // The session ended or the account was deactivated while the page was open: leave the page.
  if (typeof window !== 'undefined') {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    if (res.status === 401) {
      window.location.assign(
        code === 'SESSION_EXPIRED' ? `/session-expired?next=${next}` : `/login?next=${next}`,
      );
    } else if (res.status === 403 && code === 'ACCOUNT_INACTIVE') {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload drops all client state after the session ended
      window.location.assign('/account-inactive');
    }
  }
  return new ClientApiError(res.status, message, code, details);
}

/** POST for creations and actions; PUT only where the API replaces a resource (recipe drafts). */
export async function apiSend<T extends z.ZodType>(
  method: 'POST' | 'PUT',
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, {
    method,
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return schema.parse(await res.json());
}

export async function apiGet<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${API_BASE_PATH}/${path.replace(/^\//, '')}`, { cache: 'no-store' });
  if (!res.ok) throw await readError(res);
  return schema.parse(await res.json());
}
