import { labelTemplateSummarySchema } from '@ayvo/types';
import { z } from 'zod';
import { CreateBottlesForm } from '@/components/bottles/create-bottles-form';
import { PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function CreateBottlesPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string }>;
}) {
  const { version } = await searchParams;
  const templates = await apiGet('admin/label-templates', z.array(labelTemplateSummarySchema));
  return (
    <>
      <PageHeader
        title="Create bottles"
        subtitle="Registers new physical bottle identities (code + permanent QR) and prepares their labels."
        back={{ href: '/bottles', label: 'Bottles' }}
      />
      <CreateBottlesForm templates={templates} preselectedVersionId={version} />
    </>
  );
}
