'use client';

import { useRef } from 'react';
import { returnsCs } from '@/i18n/cs/returns';
import { ClientApiError } from '@/lib/client-api';

/**
 * One request id per intended action (`key` = the action and its payload): kept while the answer
 * is uncertain (no answer or a server error), so "the same action again" is the same request and
 * the API replays it instead of recording a second piece; renewed after any definite answer.
 */
export function useStableRequests() {
  const pending = useRef(new Map<string, string>());
  return async function send<T>(key: string, fn: (requestId: string) => Promise<T>): Promise<T> {
    const requestId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, requestId);
    try {
      const result = await fn(requestId);
      pending.current.delete(key);
      return result;
    } catch (err) {
      if (err instanceof ClientApiError && err.status < 500) pending.current.delete(key);
      throw err;
    }
  };
}

export function isUncertain(err: unknown): boolean {
  return !(err instanceof ClientApiError) || err.status >= 500;
}

/** Czech text of a failed request: the code's own text, else by status — never `e.message`. */
export function errorText(err: unknown): string {
  if (isUncertain(err)) return returnsCs.uncertain;
  const e = err as ClientApiError;
  if (e.code && returnsCs.errors[e.code]) return returnsCs.errors[e.code]!;
  if (e.status === 403) return returnsCs.refused.forbidden;
  if (e.status === 400 || e.status === 422) return returnsCs.refused.invalid;
  if (e.status === 404) return returnsCs.refused.notFound;
  return returnsCs.refused.other;
}
