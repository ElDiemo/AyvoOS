import 'server-only';
import { contractOpen, PortalUnavailable } from './backend';
import { portalEnv } from './env';
import { readCookie, SESSION_COOKIE } from './session';
import { boundedPassThrough, contentLengthWithin, deadline, readBounded, SlotLimit } from './slots';

/** §8: one budget of 20 s for the whole PDF request (fetch, reading and passing it on). */
const PDF_DEADLINE_MS = 20_000;
/** The receivers name the file with [A-Za-z0-9_-] only. */
const DISPOSITION = /^attachment; filename="[A-Za-z0-9_-]{1,64}\.pdf"$/;
/** The largest refusal body read for its code. */
const REFUSAL_MAX_BYTES = 4096;
/** One budget of PDFs in flight for the whole process (every PDF route together). */
let slots: SlotLimit | null = null;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * A PDF passed through from a unit's contract (e.g. Finance's invoice) without
 * buffering it here (ADR 0045 §8, review 5818694161):
 * - at most PORTAL_PDF_MAX_IN_FLIGHT at once (the rest 503 at once), and the transfer also holds
 *   one of the receiver's call slots;
 * - **one deadline** of 20 s covers the fetch, the transfer and the answer; the browser leaving
 *   ends it too;
 * - the receiver's headers are checked: `application/pdf`, a Content-Length (if sent) within
 *   `maxBytes`, a Content-Disposition of the expected shape (else a neutral one); the bytes are
 *   counted while passing and cut beyond `maxBytes`, whatever the header said;
 * - every slot is held until the transfer has ended and, on an early end, until the receiver's
 *   response has really been cancelled — the next request can never overtake that cleanup.
 * The receiver checks the session's scope; anything outside it is 404.
 */
export async function passPdf(
  request: Request,
  id: string,
  options: {
    unit: 'core' | 'finance';
    path: (id: string) => string;
    maxBytes: number;
    busy: string;
    unavailable: string;
  },
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return plain(404, 'Nenalezeno');
  return passFile(request, {
    unit: options.unit,
    path: options.path(encodeURIComponent(id)),
    type: 'application/pdf',
    disposition: DISPOSITION,
    maxBytes: options.maxBytes,
    deadlineMs: PDF_DEADLINE_MS,
    busy: options.busy,
    unavailable: options.unavailable,
  });
}

/**
 * A file of a given type passed through from a contract (see passPdf). `refused`, when given,
 * turns the receiver's refusals (400, 404, 409, 422, its 503 with a code) into this answer
 * instead of a bare text — e.g. a redirect back to the page with the reason. With it, a full
 * local slot is `refused(503, 'BUSY')` and the receiver being unreachable or unusable is
 * `refused(503, null)`, so such a caller never shows a bare error page.
 */
export async function passFile(
  request: Request,
  options: {
    unit: 'core' | 'finance';
    path: string;
    type: string;
    disposition: RegExp;
    maxBytes: number;
    deadlineMs: number;
    busy: string;
    unavailable: string;
    refused?: (status: number, code: string | null) => Response;
    /**
     * The transfer's slot (null: full → BUSY); its release gets the bytes the receiver announced
     * (0 when nothing was passed on), once the body has been pulled or the transfer cut. Default:
     * the PDFs' own slots.
     */
    acquire?: () => ((bytes: number) => void) | null;
  },
): Promise<Response> {
  const session = await readCookie(SESSION_COOKIE);
  if (!session) return plain(401, 'Přihlaste se prosím znovu.');
  slots ??= new SlotLimit(portalEnv().PORTAL_PDF_MAX_IN_FLIGHT);
  const releasePdf: ((bytes: number) => void) | null = options.acquire
    ? options.acquire()
    : slots.acquire();
  if (!releasePdf) return options.refused?.(503, 'BUSY') ?? plain(503, options.busy);
  const stop = deadline(options.deadlineMs, request.signal);
  let call: Awaited<ReturnType<typeof contractOpen>>;
  try {
    call = await contractOpen(options.unit, options.path, {
      session,
      signal: stop.signal,
    });
  } catch (error) {
    stop.done();
    releasePdf(0);
    if (error instanceof PortalUnavailable)
      return options.refused?.(503, null) ?? plain(503, options.unavailable);
    throw error;
  }
  const { res } = call;
  /** `bytes`: what was passed on to the browser as announced (0 for a refusal). */
  const release = (bytes = 0) => {
    stop.done();
    call.finish();
    releasePdf(bytes);
  };
  const disposition = res.headers.get('content-disposition');
  const length = res.headers.get('content-length');
  const usable =
    res.ok &&
    res.body !== null &&
    res.headers.get('content-type')?.split(';')[0]?.trim() === options.type &&
    contentLengthWithin(length, options.maxBytes);
  if (!usable) {
    let code: string | null = null;
    if (
      options.refused &&
      [400, 404, 409, 422, 503].includes(res.status) &&
      contentLengthWithin(length, REFUSAL_MAX_BYTES)
    ) {
      // A small JSON refusal (its code only), read within its own byte limit and the deadline.
      try {
        const bytes = await readBounded(res.body, {
          maxBytes: REFUSAL_MAX_BYTES,
          stop: stop.signal,
        });
        const parsed = (JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown }).code;
        code = typeof parsed === 'string' && /^[A-Z_]{2,64}$/.test(parsed) ? parsed : null;
      } catch {
        await res.body?.cancel().catch(() => undefined);
        code = null;
      }
    } else await res.body?.cancel().catch(() => undefined);
    release();
    if (options.refused && res.status !== 503 && [400, 404, 409, 422].includes(res.status))
      return options.refused(res.status, code);
    if (options.refused && res.status === 503 && code) return options.refused(503, code);
    if (res.status === 404) return plain(404, 'Nenalezeno');
    if (res.status === 401) return plain(401, 'Přihlaste se prosím znovu.');
    return options.refused?.(503, null) ?? plain(503, options.unavailable);
  }
  const body = boundedPassThrough(res.body!, {
    stop: stop.signal,
    // Never more than the receiver announced, and never more than the limit.
    maxBytes: length ? Number(length) : options.maxBytes,
    release: () => release(length ? Number(length) : options.maxBytes),
    // The fetch shares the deadline's signal; cancelling its body ends the receiver's response.
    abortUpstream: () => undefined,
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': options.type,
      ...(length ? { 'Content-Length': length } : {}),
      'Content-Disposition':
        disposition && options.disposition.test(disposition) ? disposition : 'attachment',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
