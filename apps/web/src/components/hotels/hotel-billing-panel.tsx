import {
  hotelBillingTermsSchema,
  INVOICES_OF_HOTEL_LIMIT,
  invoiceSummarySchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { financeAmount, financeDate, financeMonth } from '@/components/finance/finance-format';
import { buttonClass, Card, Field, FieldList, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { hotelsCs } from '@/i18n/cs/hotels';
import { apiGetPanel } from '@/lib/api';

const t = hotelsCs.detail.billing;
const inv = financeCs.invoices;

/**
 * "Smlouva a fakturace" on a hotel's card (doc 044 U2): what Finance says, through its own API and
 * permissions, nothing computed here. Contract and invoices are judged separately. A failure says
 * the data is unavailable, never that there is no agreement, and never takes the page down.
 */
export async function HotelBillingPanel({
  hotelId,
  canBilling,
  canInvoices,
  canManage,
}: {
  hotelId: string;
  canBilling: boolean;
  canInvoices: boolean;
  canManage: boolean;
}) {
  const [billing, invoices] = await Promise.all([
    canBilling
      ? apiGetPanel(`admin/finance/billing/agreements/by-hotel/${hotelId}`, hotelBillingTermsSchema)
      : null,
    canInvoices
      ? apiGetPanel('admin/finance/invoices', z.array(invoiceSummarySchema), { hotelId })
      : null,
  ]);
  const down = billing?.state === 'unavailable' || invoices?.state === 'unavailable';
  const b = billing?.state === 'ok' ? billing.data : null;
  const terms = b?.terms ?? null;
  const v = terms?.version ?? null;
  const c = terms?.customer ?? null;
  const list = invoices?.state === 'ok' ? invoices.data : null;
  return (
    <Card title={t.title} testId="hotel-billing">
      <div className="flex flex-col gap-4 text-sm">
        {down && <Notice tone="warning">{t.unavailable}</Notice>}
        {b && !terms && (
          <div className="flex flex-wrap items-center gap-3" data-testid="hotel-billing-none">
            <span>{t.noAgreement}</span>
            {canManage && (
              <Link
                href={`/finance/billing?hotel=${hotelId}`}
                className={buttonClass.secondary}
                data-testid="hotel-billing-create"
              >
                {t.createAgreement}
              </Link>
            )}
          </div>
        )}
        {b && terms && (
          <div data-testid="hotel-billing-terms">
            <p className="mb-2 text-xs text-stone-500" data-testid="hotel-billing-month">
              {t.asOf(financeMonth(b.month))}
            </p>
            {terms.status !== 'IN_EFFECT' && <Notice tone="warning">{t.notInEffect}</Notice>}
            {terms.gaps.length > 0 && (
              <Notice tone="warning">{terms.gaps.map((g) => inv.gaps[g] ?? g).join(', ')}</Notice>
            )}
            <FieldList>
              <Field label={t.agreement}>
                <Link
                  href={`/finance/billing/agreements/${terms.agreement.code}`}
                  className="font-mono underline"
                  data-testid="hotel-billing-agreement"
                >
                  {terms.agreement.code}
                </Link>
              </Field>
              {c && (
                <Field label={t.payer}>
                  <Link
                    href={`/finance/billing/customers/${c.code}`}
                    className="underline"
                    data-testid="hotel-billing-payer"
                  >
                    {c.customer.legalName}
                  </Link>
                </Field>
              )}
              {v && (
                <>
                  <Field label={t.rooms}>
                    <span data-testid="hotel-billing-rooms">{v.billedRooms}</span>
                  </Field>
                  <Field label={t.price}>
                    <span data-testid="hotel-billing-price">
                      {terms.price.perRoomMonth
                        ? financeAmount(terms.price.perRoomMonth, v.currency)
                        : '—'}{' '}
                      ({t.priceSource[terms.price.source]})
                    </span>
                  </Field>
                  <Field label={t.paymentTerms}>{t.days(v.paymentTermsDays)}</Field>
                  <Field label={t.validity}>
                    {t.validFromTo(
                      financeDate(v.validFrom),
                      v.validTo ? financeDate(v.validTo) : null,
                    )}
                  </Field>
                </>
              )}
            </FieldList>
          </div>
        )}
        {list && (
          <div data-testid="hotel-billing-invoices">
            <h3 className="mb-1 font-medium">{t.invoices}</h3>
            {list.length === 0 ? (
              <p className="text-stone-500">{t.noInvoices}</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {list.map((i) => (
                  <li key={i.number} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <Link href={`/finance/invoices/${i.number}`} className="font-mono underline">
                      {i.number}
                    </Link>
                    <span>{financeMonth(i.period)}</span>
                    <span className="tabular-nums">{financeAmount(i.total, i.currency)}</span>
                    <span className="font-medium">
                      {i.status === 'CANCELLED'
                        ? t.cancelled
                        : `${inv.paymentState[i.paymentState.state]}${i.paymentState.overdue ? ` · ${inv.overdue}` : ''}`}
                    </span>
                    {i.hotels.length > 1 && (
                      <span
                        className="text-xs text-stone-500"
                        data-testid={`hotel-invoice-summary-${i.number}`}
                      >
                        {t.summaryInvoice(i.hotels.length)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {list.length >= INVOICES_OF_HOTEL_LIMIT && (
              <p className="mt-1 text-xs text-stone-500">{t.limited(INVOICES_OF_HOTEL_LIMIT)}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
