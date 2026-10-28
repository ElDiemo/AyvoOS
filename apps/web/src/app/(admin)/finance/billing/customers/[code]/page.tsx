import { billingCustomerDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { CustomerForm } from '@/components/finance/billing-forms';
import { FinanceHeader } from '@/components/finance/finance-header';
import { Card } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { ApiError, apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** One customer (the billed company): its versions and a new version with a reason. */
export default async function CustomerPage({ params }: { params: Promise<{ code: string }> }) {
  const me = await requirePermission('finance:billing_read');
  const { code } = await params;
  if (!/^CU-\d{6,}$/.test(code)) notFound();
  const c = await apiGet(
    `admin/finance/billing/customers/${code}`,
    billingCustomerDetailSchema,
  ).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={c.current.customer.legalName}
        subtitle={c.code}
        back={{ href: '/finance/billing', label: t.back }}
      />
      <div className="flex flex-col gap-6">
        <Card title={t.history}>
          <ul className="divide-y divide-stone-100 text-sm">
            {c.versions.map((v) => (
              <li key={v.version} className="flex flex-col gap-1 py-2">
                <span className="font-medium">
                  {t.version(v.version)}: {v.customer.legalName}
                  {v.customer.companyId ? `, IČO ${v.customer.companyId}` : ''}
                  {v.customer.vatId ? `, DIČ ${v.customer.vatId}` : ''}
                </span>
                <span className="text-stone-600">
                  {v.customer.addressLine1}, {v.customer.postalCode} {v.customer.city} ·{' '}
                  {v.customer.billingEmail}
                </span>
                <span className="text-xs text-stone-500">
                  {v.reason ? `${v.reason} · ` : ''}
                  {t.recorded(formatDateTimeCs(v.recordedAt), v.recordedByName)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {hasPermission(me, 'finance:billing_manage') && (
          <Card title={t.newVersion}>
            <CustomerForm code={c.code} current={c.current} />
          </Card>
        )}
      </div>
    </>
  );
}
