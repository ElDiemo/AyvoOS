import {
  billingAgreementSchema,
  billingCustomerSchema,
  effectiveTermsPageSchema,
  financeContractHotelSchema,
  priceListVersionSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { AgreementForm, CustomerForm, PriceForm } from '@/components/finance/billing-forms';
import { financeAmount, financeMonth } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { buttonClass, Card, Notice } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

const thisMonth = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7);

/** A short empty state with the next step (UI-03): no tall blank card. */
function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm text-stone-600">
      <span>{children}</span>
      {action}
    </div>
  );
}

/**
 * Smlouvy a ceny (doc 040, N3A-1 in the UI; a view of Faktury hotelům, doc 042): customers (the
 * billed companies), one agreement per hotel with versioned terms, and the default price list.
 * Hotels come from the core contract. `?new=customer|agreement` opens that existing form (links
 * from the overview and the empty states); nothing is created by itself.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const opened = (await searchParams).new;
  const me = await requirePermission('finance:billing_read');
  const canManage = hasPermission(me, 'finance:billing_manage');
  const month = thisMonth();
  const [agreements, customers, prices, hotels, effective] = await Promise.all([
    apiGet('admin/finance/billing/agreements', z.array(billingAgreementSchema)),
    apiGet('admin/finance/billing/customers', z.array(billingCustomerSchema)),
    apiGet('admin/finance/billing/price-list', z.array(priceListVersionSchema)),
    apiGet('admin/finance/billing/hotels', z.array(financeContractHotelSchema)),
    apiGet(`admin/finance/billing/agreements/effective?month=${month}`, effectiveTermsPageSchema),
  ]);
  const withAgreement = new Set(agreements.map((a) => a.hotel.id));
  const free = hotels.filter((h) => !withAgreement.has(h.id));
  const termsOf = (code: string) => effective.items.find((i) => i.agreement.code === code);
  return (
    <>
      <FinanceHeader active="invoices" view="billing" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        <Card title={t.agreements} testId="billing-agreements" id="agreements">
          {agreements.length === 0 ? (
            <Empty
              action={
                canManage &&
                customers.length === 0 && (
                  <Link
                    href="/finance/billing?new=customer#customers"
                    className={buttonClass.secondary}
                    data-testid="agreements-need-customer"
                  >
                    {t.createCustomer}
                  </Link>
                )
              }
            >
              {customers.length === 0 ? t.noAgreementsNoCustomer : t.noAgreements}
            </Empty>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {agreements.map((a) => {
                const e = termsOf(a.code);
                const v = e?.version;
                return (
                  <li key={a.code} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <Link
                      href={`/finance/billing/agreements/${a.code}`}
                      className="font-mono underline"
                    >
                      {a.code}
                    </Link>
                    <span className="min-w-0 flex-1 font-medium">{a.hotel.name}</span>
                    <span className="text-stone-600">{e?.customer?.customer.legalName ?? '—'}</span>
                    <span className="tabular-nums">
                      {v
                        ? t.current(
                            v.billedRooms,
                            e.price.perRoomMonth
                              ? `${financeAmount(e.price.perRoomMonth, v.currency)} (${
                                  e.price.source === 'OWN' ? t.ownPrice : t.defaultPrice
                                })`
                              : '—',
                          )
                        : `${financeMonth(month)}: —`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {canManage && (
            <details className="mt-4" open={opened === 'agreement'}>
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="agreement-new-open"
              >
                {t.newAgreement}
              </summary>
              <div className="mt-3">
                {customers.length === 0 ? (
                  <Notice tone="info">
                    {t.needCustomer}{' '}
                    <Link href="/finance/billing?new=customer#customers" className="underline">
                      {t.createCustomer}
                    </Link>
                  </Notice>
                ) : free.length === 0 ? (
                  <Notice tone="info">{t.noFreeHotel}</Notice>
                ) : (
                  <AgreementForm hotels={free} customers={customers} />
                )}
              </div>
            </details>
          )}
        </Card>

        <Card title={t.customers} testId="billing-customers" id="customers">
          <p className="mb-3 text-xs text-stone-500">{t.customersHelp}</p>
          {customers.length === 0 ? (
            <Empty>{t.noCustomers}</Empty>
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
                    {c.current.customer.companyId ? `IČO ${c.current.customer.companyId}` : ''}{' '}
                    {c.current.customer.city}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
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

        <Card title={t.priceList} testId="billing-prices">
          <p className="mb-3 text-xs text-stone-500">{t.priceListHelp}</p>
          {prices.length === 0 ? (
            <Empty>{t.noPrices}</Empty>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {prices.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <span className="tabular-nums font-medium">
                    {financeAmount(p.pricePerRoomMonth, p.currency)}
                  </span>
                  <span>od {financeMonth(p.effectiveFrom)}</span>
                  <span className="text-stone-600">{p.reason}</span>
                  <span className="text-xs text-stone-500">{t.revision(p.revision)}</span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">{t.newPrice}</summary>
              <div className="mt-3">
                <PriceForm prices={prices} />
              </div>
            </details>
          )}
        </Card>
      </div>
    </>
  );
}
