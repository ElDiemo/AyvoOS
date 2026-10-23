import { employeeCardSlugSchema } from '@ayvo/types';
import { z } from 'zod';
import { fetchEmployeeCard } from '@/lib/employee-card-public';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const version = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(new URL(request.url).searchParams.get('version'));
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!employeeCardSlugSchema.safeParse(slug).success || !version.success)
    return new Response(null, { status: 404, headers });
  const res = await fetchEmployeeCard(`${slug}/photo?version=${version.data}`);
  if (!res.ok) return new Response(null, { status: res.status, headers });
  return new Response(await res.arrayBuffer(), {
    headers: { ...headers, 'Content-Type': 'image/png' },
  });
}
