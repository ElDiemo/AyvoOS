import { salespersonSchema } from '@ayvo/types';
import { z } from 'zod';
import { ProspectForm } from '@/components/sales/prospect-form';
import { SalesHeader } from '@/components/sales/sales-header';
import { salesCs as t } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Nový zájemce: a name and a country are enough (doc 034 §3). */
export default async function NewProspectPage() {
  const me = await requirePermission('sales:work');
  const salespeople = hasPermission(me, 'sales:manage')
    ? await apiGet('admin/sales/salespeople', z.array(salespersonSchema))
    : null;
  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.form.newTitle}
        subtitle={t.form.newSubtitle}
        back={{ href: '/sales/prospects', label: t.list.title }}
      />
      <ProspectForm prospect={null} salespeople={salespeople} />
    </>
  );
}
