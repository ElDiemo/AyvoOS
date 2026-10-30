import { billingCustomerDetailSchema, effectiveTermsPageSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerForm } from '@/components/finance/billing-forms';
import { FinanceHeader } from '@/components/finance/finance-header';
import { Card, Field, FieldList } from '@/components/ui';
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
  // Which hotels it pays for now: Finance's computation of the month, never a second record.
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' })
    .format(new Date())
    .slice(0, 7);
  const terms = await apiGet(
    `admin/finance/billing/agreements/effective?month=${month}`,
    effectiveTermsPageSchema,
  );
  const paid = terms.items.filter((i) => i.customer?.id === c.id);
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={c.current.customer.legalName}
        subtitle={c.code}
        back={{ href: '/finance/billing/customers', label: t.customers }}
      />
      <div className="flex flex-col gap-6">
        <Card title={t.currentData} testId="customer-current">
          <FieldList>
            <Field label={t.fields.legalName}>{c.current.customer.legalName}</Field>
            <Field label={t.fields.companyId}>{c.current.customer.companyId ?? '—'}</Field>
            <Field label={t.fields.vatId}>{c.current.customer.vatId ?? '—'}</Field>
            <Field label={t.fields.addressLine1}>
              {c.current.customer.addressLine1}, {c.current.customer.postalCode}{' '}
              {c.current.customer.city}, {c.current.customer.countryCode}
            </Field>
            <Field label={t.fields.billingEmail}>
              <span className="break-all">{c.current.customer.billingEmail}</span>
            </Field>
          </FieldList>
          <p className="mt-2 text-xs text-stone-500">{t.version(c.current.version)}</p>
          {hasPermission(me, 'finance:billing_manage') && (
            <details className="mt-3">
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="customer-edit-open"
              >
                {t.edit}
              </summary>
              <div className="mt-3">
                <CustomerForm code={c.code} current={c.current} />
              </div>
            </details>
          )}
        </Card>
        <Card title={t.payerHotels(month)} testId="payer-hotels">
          <p className="mb-2 text-xs text-stone-500">{t.payerHelp}</p>
          {paid.length === 0 ? (
            <p className="text-sm text-stone-500">{t.payerNoHotels}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {paid.map((i) => (
                <li key={i.agreement.code} className="flex flex-wrap gap-x-4 py-2">
                  <Link
                    href={`/finance/billing/agreements/${i.agreement.code}`}
                    className="underline"
                  >
                    {i.agreement.hotel.name}
                  </Link>
                  <span className="font-mono text-xs text-stone-500">{i.agreement.code}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t.history} testId="customer-history">
          <details>
            <summary
              className="cursor-pointer text-sm font-medium"
              data-testid="customer-history-open"
            >
              {t.historyOpen(c.versions.length)}
            </summary>
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
          </details>
        </Card>
      </div>
    </>
  );
}
