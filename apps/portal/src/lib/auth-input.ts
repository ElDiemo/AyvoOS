import { contentLengthWithin, deadline, readBounded, SlotLimit, TransferCut } from './slots';

/**
 * Limits on the public sign-in steps' input in portal-web (review 5818694161), before anything
 * reaches the core:
 * - **bytes:** at most 4 KiB of body, counted while reading (a Content-Length is checked first
 *   when sent, but never trusted: chunked bodies are counted too);
 * - **time:** the body must arrive within 5 s, else the read is cut;
 * - **in progress:** at most 8 public steps read or wait on the core at once in this process; the
 *   rest are refused at once (503) and never queue.
 * The edge in front of portal-web (DEV/PROD, ADR 0045 §7) must also cap the body size and the time
 * to read it; this is the second, independent limit.
 */
export const AUTH_INPUT_MAX_BYTES = 4 * 1024;
export const AUTH_INPUT_DEADLINE_MS = 5_000;
export const AUTH_STEPS_IN_FLIGHT = 8;

const steps = new SlotLimit(AUTH_STEPS_IN_FLIGHT);
/** For tests and diagnostics: public steps in progress. */
export const authStepsInFlight = () => steps.inFlight;

export type InputOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'too-large' }
  | { kind: 'too-slow' }
  | { kind: 'invalid' };

/** Takes one of the public step slots, or null when all are busy. */
export const acquireAuthStep = () => steps.acquire();

/** The request's JSON body within the byte and time limits (nothing parsed beyond them). */
export async function readInput(
  request: Request,
  limits: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<InputOutcome> {
  const maxBytes = limits.maxBytes ?? AUTH_INPUT_MAX_BYTES;
  if (!contentLengthWithin(request.headers.get('content-length'), maxBytes)) {
    await request.body?.cancel().catch(() => undefined);
    return { kind: 'too-large' };
  }
  const stop = deadline(limits.deadlineMs ?? AUTH_INPUT_DEADLINE_MS, request.signal);
  try {
    const bytes = await readBounded(request.body, { maxBytes, stop: stop.signal });
    return { kind: 'ok', value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch (error) {
    if (error instanceof TransferCut)
      return error.reason === 'TOO_LARGE' ? { kind: 'too-large' } : { kind: 'too-slow' };
    return { kind: 'invalid' };
  } finally {
    stop.done();
  }
}
