import { employeeCardSlugSchema, publicEmployeeCardSchema } from '@ayvo/types';
import { notFound, redirect } from 'next/navigation';
import { EmployeeCard } from '@/components/identity/employee-card';
import { fetchEmployeeCard } from '@/lib/employee-card-public';
import { serverEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'AYVO · Contact', robots: { index: false, follow: false } };

export default async function EmployeeCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  if (!employeeCardSlugSchema.safeParse(slug).success) notFound();
  const res = await fetchEmployeeCard(slug);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error('Vizitka je dočasně nedostupná.');
  const card = publicEmployeeCardSchema.parse(await res.json());
  // Compatibility with the existing PHP Save contact link, keyed to the path, not query.slug.
  if ((await searchParams).vcard !== undefined) redirect(`${slug}/contact.vcf`);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f6f6f6] p-4 sm:p-6">
      {serverEnv.APP_ENV !== 'production' && (
        <p className="max-w-sm text-center text-xs text-amber-900">
          TEST – ukázka vizitky ve vývojovém prostředí, ne skutečná veřejná vizitka.
        </p>
      )}
      <EmployeeCard
        fields={card}
        photoUrl={card.hasPhoto ? `${slug}/photo?version=${card.version}` : undefined}
        contactUrl={`${slug}/contact.vcf`}
      />
    </main>
  );
}
