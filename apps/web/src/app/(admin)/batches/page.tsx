import { redirect } from 'next/navigation';

/** The former "Creation batches" list now lives in Bottles → Creation history. */
export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.floor(Number((await searchParams).page));
  redirect(page > 1 ? `/bottles/history?page=${page}` : '/bottles/history');
}
