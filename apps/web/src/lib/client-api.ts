import { API_BASE_PATH } from '@ayvo/types';
import type { z } from 'zod';

/** Browser-side calls to the same-origin API (/api/admin/...). */
export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ClientApiError> {
  let message = `Request failed (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as {
      message?: unknown;
      issues?: { path: string; message: string }[];
    };
    if (body.issues?.length) {
      message = body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // non-JSON error body: keep the generic message
  }
  if (res.status === 413) message = 'The file is too large';
  return new ClientApiError(res.status, message);
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
