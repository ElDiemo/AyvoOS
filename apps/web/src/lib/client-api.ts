import { API_BASE_PATH } from '@ayvo/types';
import type { z } from 'zod';

/** Browser-side calls to the same-origin API (/api/admin/...). */
export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Stable domain error code from the API (e.g. "LOT_EXHAUSTED"), if any. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ClientApiError> {
  let message = `Požadavek se nezdařil (HTTP ${res.status})`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as {
      message?: unknown;
      code?: unknown;
      issues?: { path: string; message: string }[];
    };
    if (typeof body.code === 'string') code = body.code;
    if (body.issues?.length) {
      message = body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // non-JSON error body: keep the generic message
  }
  if (res.status === 413) message = 'Soubor je příliš velký';
  return new ClientApiError(res.status, message, code);
}

export async function apiSend<T extends z.ZodType>(
  method: 'POST',
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
