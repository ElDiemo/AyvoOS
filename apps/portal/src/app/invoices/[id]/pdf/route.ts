import { contractOpen, PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { readCookie, SESSION_COOKIE } from '@/lib/session';
import { boundedPassThrough, contentLengthWithin, deadline, SlotLimit } from '@/lib/slots';

export const dynamic = 'force-dynamic';

/** §8: one budget of 20 s for the whole PDF request (fetch, reading and passing it on); 10 MB. */
const PDF_DEADLINE_MS = 20_000;
const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Finance names the file after the invoice number, reduced to [A-Za-z0-9_-]. */
const DISPOSITION = /^attachment; filename="[A-Za-z0-9_-]{1,64}\.pdf"$/;
let slots: SlotLimit | null = null;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * An invoice PDF, passed through from Finance without buffering it here (ADR 0045 §8,
 * review 5818694161):
 * - at most PORTAL_PDF_MAX_IN_FLIGHT at once (the rest 503 at once), and the transfer also holds
 *   one of the Finance call slots;
 * - **one deadline** of 20 s covers the fetch, the transfer and the answer; the browser leaving
 *   ends it too;
 * - Finance's headers are checked: `application/pdf`, a Content-Length (if sent) within 10 MB, a
 *   Content-Disposition of the expected shape (else a neutral one); the bytes are counted while
 *   passing and cut beyond 10 MB, whatever the header said;
 * - every slot is held until the transfer has ended and, on an early end, until Finance's response
 *   has really been cancelled — the next request can never overtake that cleanup.
 * Finance has checked the session's scope; another payer's invoice is 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return plain(404, 'Nenalezeno');
  const session = await readCookie(SESSION_COOKIE);
  if (!session) return plain(401, 'Přihlaste se prosím znovu.');
  slots ??= new SlotLimit(portalEnv().PORTAL_PDF_MAX_IN_FLIGHT);
  const releasePdf = slots.acquire();
  if (!releasePdf) return plain(503, 'Faktury jsou teď vytížené. Zkuste to za chvíli.');
  const stop = deadline(PDF_DEADLINE_MS, request.signal);
  let call: Awaited<ReturnType<typeof contractOpen>>;
  try {
    call = await contractOpen('finance', `invoices/${encodeURIComponent(id)}/pdf`, {
      session,
      signal: stop.signal,
    });
  } catch (error) {
    stop.done();
    releasePdf();
    if (error instanceof PortalUnavailable) return plain(503, 'Faktury nejsou dostupné.');
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
    contentLengthWithin(length, PDF_MAX_BYTES);
  if (!usable) {
    await res.body?.cancel().catch(() => undefined);
    release();
    if (res.status === 404) return plain(404, 'Nenalezeno');
    if (res.status === 401) return plain(401, 'Přihlaste se prosím znovu.');
    return plain(503, 'Faktury nejsou dostupné.');
  }
  const body = boundedPassThrough(res.body!, {
    stop: stop.signal,
    // Never more than Finance announced, and never more than 10 MB.
    maxBytes: length ? Number(length) : PDF_MAX_BYTES,
    release,
    // The fetch shares the deadline's signal; cancelling its body ends Finance's response.
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
