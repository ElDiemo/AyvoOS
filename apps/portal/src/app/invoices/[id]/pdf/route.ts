import { contractFetch, PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { readCookie, SESSION_COOKIE } from '@/lib/session';
import { boundedPassThrough, SlotLimit } from '@/lib/slots';

export const dynamic = 'force-dynamic';

/** §8: the PDF budget of 20 s covers fetching and passing the file through. */
const PDF_DEADLINE_MS = 20_000;
let slots: SlotLimit | null = null;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * An invoice PDF, passed through from Finance without buffering it here (ADR 0045 §8): at most
 * PORTAL_PDF_MAX_IN_FLIGHT at once (the rest 503 at once), each holding its slot until the bytes
 * have left — completed, the browser gone, or the deadline passed — and every early end aborts
 * Finance's response too. Finance has checked the session's scope; another invoice is 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return plain(404, 'Nenalezeno');
  const session = await readCookie(SESSION_COOKIE);
  if (!session) return plain(401, 'Přihlaste se prosím znovu.');
  slots ??= new SlotLimit(portalEnv().PORTAL_PDF_MAX_IN_FLIGHT);
  const release = slots.acquire();
  if (!release) return plain(503, 'Faktury jsou teď vytížené. Zkuste to za chvíli.');
  const upstream = new AbortController();
  request.signal.addEventListener('abort', () => upstream.abort(), { once: true });
  let res: Response;
  try {
    res = await contractFetch('finance', `invoices/${encodeURIComponent(id)}/pdf`, {
      session,
      signal: upstream.signal,
      timeoutMs: PDF_DEADLINE_MS,
    });
  } catch (error) {
    release();
    if (error instanceof PortalUnavailable) return plain(503, 'Faktury nejsou dostupné.');
    throw error;
  }
  if (!res.ok || !res.body || !res.headers.get('content-type')?.startsWith('application/pdf')) {
    release();
    upstream.abort();
    if (res.status === 404) return plain(404, 'Nenalezeno');
    if (res.status === 401) return plain(401, 'Přihlaste se prosím znovu.');
    return plain(503, 'Faktury nejsou dostupné.');
  }
  const body = boundedPassThrough(res.body, {
    deadlineMs: PDF_DEADLINE_MS,
    release,
    abortUpstream: () => upstream.abort(),
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      ...(res.headers.get('content-length')
        ? { 'Content-Length': res.headers.get('content-length')! }
        : {}),
      'Content-Disposition': res.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
