import 'server-only';
import { contractOpen, PortalUnavailable } from './backend';
import { portalEnv } from './env';
import { readCookie, SESSION_COOKIE } from './session';
import { boundedPassThrough, contentLengthWithin, deadline, SlotLimit } from './slots';

/** §8: one budget of 20 s for the whole PDF request (fetch, reading and passing it on). */
const PDF_DEADLINE_MS = 20_000;
/** The receivers name the file with [A-Za-z0-9_-] only. */
const DISPOSITION = /^attachment; filename="[A-Za-z0-9_-]{1,64}\.pdf"$/;
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
  const session = await readCookie(SESSION_COOKIE);
  if (!session) return plain(401, 'Přihlaste se prosím znovu.');
  slots ??= new SlotLimit(portalEnv().PORTAL_PDF_MAX_IN_FLIGHT);
  const releasePdf = slots.acquire();
  if (!releasePdf) return plain(503, options.busy);
  const stop = deadline(PDF_DEADLINE_MS, request.signal);
  let call: Awaited<ReturnType<typeof contractOpen>>;
  try {
    call = await contractOpen(options.unit, options.path(encodeURIComponent(id)), {
      session,
      signal: stop.signal,
    });
  } catch (error) {
    stop.done();
    releasePdf();
    if (error instanceof PortalUnavailable) return plain(503, options.unavailable);
    throw error;
  }
  const { res } = call;
  const release = () => {
    stop.done();
    call.finish();
    releasePdf();
  };
  const disposition = res.headers.get('content-disposition');
  const length = res.headers.get('content-length');
  const usable =
    res.ok &&
    res.body !== null &&
    res.headers.get('content-type')?.split(';')[0]?.trim() === 'application/pdf' &&
    contentLengthWithin(length, options.maxBytes);
  if (!usable) {
    await res.body?.cancel().catch(() => undefined);
    release();
    if (res.status === 404) return plain(404, 'Nenalezeno');
    if (res.status === 401) return plain(401, 'Přihlaste se prosím znovu.');
    return plain(503, options.unavailable);
  }
  const body = boundedPassThrough(res.body!, {
    stop: stop.signal,
    // Never more than the receiver announced, and never more than the limit.
    maxBytes: length ? Number(length) : options.maxBytes,
    release,
    // The fetch shares the deadline's signal; cancelling its body ends the receiver's response.
    abortUpstream: () => undefined,
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      ...(length ? { 'Content-Length': length } : {}),
      'Content-Disposition':
        disposition && DISPOSITION.test(disposition) ? disposition : 'attachment',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
