import { createHash } from 'node:crypto';

/**
 * A request id derived from a client's request id for one step of a combined action (e.g. the
 * label request of "Dokončit a vytisknout štítky"): the same client id always gives the same step
 * id, so a replay of the combined action replays each step instead of repeating it.
 */
export function derivedRequestId(requestId: string, step: string): string {
  const h = createHash('sha256').update(`${requestId}:${step}`).digest('hex');
  // An RFC 9562 version 8 (custom) UUID.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
