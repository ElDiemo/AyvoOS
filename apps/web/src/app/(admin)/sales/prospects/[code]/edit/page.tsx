import { prospectCodeSchema, prospectDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { ProspectForm } from '@/components/sales/prospect-form';
import { SalesHeader } from '@/components/sales/sales-header';
import { salesCs as t } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function EditProspectPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!prospectCodeSchema.safeParse(code).success) notFound();
  const prospect = await apiGet(`admin/sales/prospects/${code}`, prospectDetailSchema);
  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.form.editTitle}
        subtitle={prospect.name}
        back={{ href: `/sales/prospects/${code}`, label: prospect.name }}
      />
      <ProspectForm prospect={prospect} salespeople={null} />
    </>
  );
}
