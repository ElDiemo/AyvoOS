import { employeeCardSlugSchema } from '@ayvo/types';
import { fetchEmployeeCard } from '@/lib/employee-card-public';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!employeeCardSlugSchema.safeParse(slug).success)
    return new Response(null, { status: 404, headers });
  const res = await fetchEmployeeCard(`${slug}/contact.vcf`);
  if (!res.ok) return new Response(null, { status: res.status, headers });
  return new Response(await res.arrayBuffer(), {
    headers: {
      ...headers,
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}.vcf"`,
    },
  });
}
