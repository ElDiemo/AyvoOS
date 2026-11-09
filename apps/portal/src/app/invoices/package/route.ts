import { portalInvoicePackageQuerySchema } from '@ayvo/types';
import { passFile } from '@/lib/pdf-proxy';

export const dynamic = 'force-dynamic';

/** Finance names the package by its period. */
const DISPOSITION = /^attachment; filename="AYVO-faktury-\d{4}-\d{2}-\d{4}-\d{2}\.zip"$/;

/**
 * "Balíček za období" (doc 040 §14): a ZIP of the visible invoices of the period from Finance,
 * passed through like a PDF (one deadline above Finance's own, counted bytes up to Finance's limit
 * plus the ZIP's small overhead). A refused period (invalid, empty, too large, busy) goes back to
 * "Faktury" with its reason; nothing else of Finance's answer is shown.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Back to the invoices with the reason. The Location is relative: behind the edge,
  // request.url names portal-web's own listener (e.g. 127.0.0.1:3200), never the public origin.
  const back = (reason: string) => {
    const query = new URLSearchParams({ balicek: reason });
    for (const k of ['from', 'to']) {
      const v = url.searchParams.get(k);
      if (v && /^\d{4}-\d{2}$/.test(v)) query.set(k, v);
    }
    return new Response(null, { status: 303, headers: { Location: `/invoices?${query}` } });
  };
  const q = portalInvoicePackageQuerySchema.safeParse({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  if (!q.success) return back('INVALID_PERIOD');
  return passFile(request, {
    unit: 'finance',
    path: `invoices/package?from=${q.data.from}&to=${q.data.to}`,
    type: 'application/zip',
    disposition: DISPOSITION,
    maxBytes: 41 * 1024 * 1024,
    deadlineMs: 65_000,
    busy: 'Balíčky se teď připravují. Zkuste to za chvíli.',
    unavailable: 'Faktury nejsou dostupné.',
    refused: (status, code) =>
      back(
        status === 400
          ? 'INVALID_PERIOD'
          : code === 'BUSY' // portal-web's own slots are full
            ? 'PACKAGE_BUSY'
            : code && ['NO_INVOICES', 'PACKAGE_TOO_LARGE', 'PACKAGE_BUSY'].includes(code)
              ? code
              : 'UNAVAILABLE', // Finance unreachable or its answer unusable
      ),
  });
}
