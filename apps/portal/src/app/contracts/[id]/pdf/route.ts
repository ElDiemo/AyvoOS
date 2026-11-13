import { passPdf } from '@/lib/pdf-proxy';

export const dynamic = 'force-dynamic';

/**
 * A signed contract (the original AYVO uploaded) from the core: at most 20 MB (the core's upload
 * limit for signed originals); only of a granted hotel, else 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return passPdf(request, (await params).id, {
    unit: 'core',
    path: (id) => `contracts/${id}/pdf`,
    maxBytes: 20 * 1024 * 1024,
    busy: 'Smlouvy jsou teď vytížené. Zkuste to za chvíli.',
    unavailable: 'Smlouvy nejsou dostupné.',
  });
}
