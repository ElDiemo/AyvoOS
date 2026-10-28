import {
  billingAgreementDetailSchema,
  billingCustomerSchema,
  invoiceSummarySchema,
} from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AgreementForm } from '@/components/finance/billing-forms';
import { financeAmount, financeDate, financeMonth } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { InvoiceList } from '@/components/finance/invoice-list';
import { Card } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { ApiError, apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * One hotel agreement: every version (newest revision first), a new version of its terms and —
 * with finance:invoices_read — the invoices with a line of this agreement (the exact link
 * invoice_lines.agreement_id, doc 042 §3b; never guessed).
 */
export default async function AgreementPage({ params }: { params: Promise<{ code: string }> }) {
  const me = await requirePermission('finance:billing_read');
  const { code } = await params;
  if (!/^BA-\d{6,}$/.test(code)) notFound();
  const canInvoices = hasPermission(me, 'finance:invoices_read');
  const [a, customers, invoices] = await Promise.all([
    apiGet(`admin/finance/billing/agreements/${code}`, billingAgreementDetailSchema).catch(
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) notFound();
        throw e;
      },
    ),
    apiGet('admin/finance/billing/customers', z.array(billingCustomerSchema)),
    canInvoices
      ? apiGet('admin/finance/invoices', z.array(invoiceSummarySchema), { agreement: code })
      : null,
  ]);
  const name = (id: string) => customers.find((c) => c.id === id)?.current.customer.legalName ?? id;
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={a.hotel.name}
        subtitle={`${a.code} · ${a.hotel.code}`}
        back={{ href: '/finance/billing', label: t.back }}
      />
      <div className="flex flex-col gap-6">
        <Card title={t.history} testId="agreement-history">
          <ul className="divide-y divide-stone-100 text-sm">
            {a.versions.map((v) => (
              <li key={v.revision} className="flex flex-col gap-1 py-2">
                <span className="font-medium">
                  {financeMonth(v.effectiveFrom)}: {v.billedRooms} pokojů ·{' '}
                  {v.ownPricePerRoomMonth
                    ? financeAmount(v.ownPricePerRoomMonth, v.currency)
                    : `${t.defaultPrice} (${v.currency})`}{' '}
                  · {name(v.customer.id)}
                </span>
                <span className="text-stone-600">
                  {t.fields.paymentTermsDays} {v.paymentTermsDays} · {t.timing[v.billingTiming]} ·{' '}
                  {financeDate(v.validFrom)} – {v.validTo ? financeDate(v.validTo) : '…'}
                  {v.contractNumber ? ` · ${v.contractNumber}` : ''}
                </span>
                <span className="text-xs text-stone-500">
                  {t.revision(v.revision)} · {v.reason} ·{' '}
                  {t.recorded(formatDateTimeCs(v.recordedAt), v.recordedByName)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {invoices && (
          <Card title={financeCs.invoices.ofAgreement} testId="agreement-invoices">
            {invoices.length === 0 ? (
              <p className="py-2 text-sm text-stone-600">{financeCs.invoices.noneOfAgreement}</p>
            ) : (
              <InvoiceList invoices={invoices} />
            )}
          </Card>
        )}
        {hasPermission(me, 'finance:billing_manage') && a.versions[0] && (
          <Card title={t.newVersion}>
            <AgreementForm code={a.code} current={a.versions[0]} customers={customers} />
          </Card>
        )}
      </div>
    </>
  );
}
