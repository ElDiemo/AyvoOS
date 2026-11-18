import { passPdf } from '@/lib/pdf-proxy';

export const dynamic = 'force-dynamic';

/** An invoice PDF from Finance (10 MB; Finance names it after the invoice number). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return passPdf(request, (await params).id, {
    unit: 'finance',
    path: (id) => `invoices/${id}/pdf`,
    maxBytes: 10 * 1024 * 1024,
    busy: 'Faktury jsou teď vytížené. Zkuste to za chvíli.',
    unavailable: 'Faktury nejsou dostupné.',
  });
}
