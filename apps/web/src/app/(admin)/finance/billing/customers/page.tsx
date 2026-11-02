import { billingCustomerSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CustomerForm } from '@/components/finance/billing-forms';
import { FinanceHeader } from '@/components/finance/finance-header';
import { Card } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Plátci (doc 044 U3): the billed companies, which are not hotels. Rights as on Smlouvy. */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: opened } = await searchParams;
  const me = await requirePermission('finance:billing_read');
  const customers = await apiGet('admin/finance/billing/customers', z.array(billingCustomerSchema));
  return (
    <>
      <FinanceHeader
        active="invoices"
        view="customers"
        title={t.customersTitle}
        subtitle={t.customersSubtitle}
      />
      <div className="flex flex-col gap-6">
        <Card testId="billing-customers">
          {customers.length === 0 ? (
            <p className="text-sm text-stone-500">{t.noCustomers}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {customers.map((c) => (
                <li key={c.code} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <Link
                    href={`/finance/billing/customers/${c.code}`}
                    className="font-mono underline"
                  >
                    {c.code}
                  </Link>
                  <span className="min-w-0 flex-1 font-medium">{c.current.customer.legalName}</span>
                  <span className="text-stone-600">
                    {c.current.customer.companyId ? `IČO ${c.current.customer.companyId} · ` : ''}
                    {c.current.customer.city}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hasPermission(me, 'finance:billing_manage') && (
            <details className="mt-4" open={opened === 'customer'}>
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="customer-new-open"
              >
                {t.newCustomer}
              </summary>
              <div className="mt-3">
                <CustomerForm />
              </div>
            </details>
          )}
        </Card>
      </div>
    </>
  );
}
