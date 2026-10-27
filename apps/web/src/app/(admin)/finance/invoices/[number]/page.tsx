import { API_BASE_PATH, invoiceDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { CancelInvoiceForm } from '@/components/finance/cancel-invoice-form';
import { financeAmount, financeDate, financeMonth } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { buttonClass, Card, Field, FieldList, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { ApiError, apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;

/** One invoice as frozen at issuing: lines, payment instructions, the stored PDF; cancellation. */
export default async function InvoicePage({ params }: { params: Promise<{ number: string }> }) {
  const me = await requirePermission('finance:invoices_read');
  const { number } = await params;
  if (!/^T\d{4}-\d{5}$/.test(number)) notFound();
  const inv = await apiGet(`admin/finance/invoices/${number}`, invoiceDetailSchema).catch(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    },
  );
  const canCancel = hasPermission(me, 'finance:invoices_test') && inv.status === 'VALID';
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={`${t.newTitle} ${inv.number}`}
        subtitle={`${inv.customer.legalName} · ${financeMonth(inv.period)}`}
        back={{ href: '/finance/invoices', label: t.back }}
        actions={
          <a
            href={`${API_BASE_PATH}/admin/finance/invoices/${inv.number}/pdf`}
            className={buttonClass.secondary}
            data-testid="invoice-pdf"
          >
            {t.pdf}
          </a>
        }
      />
      <div className="flex flex-col gap-6" data-testid="invoice-detail">
        {inv.cancellation ? (
          <Notice tone="warning">
            {t.cancelled(
              inv.cancellation.reason,
              inv.cancellation.cancelledByName,
              formatDateTimeCs(inv.cancellation.cancelledAt),
            )}
          </Notice>
        ) : (
          <Notice tone="warning">{t.testOnly}</Notice>
        )}
        <Card>
          <FieldList>
            <Field label={t.customer}>
              {inv.customer.legalName}{' '}
              <span className="font-mono text-xs text-stone-500">{inv.customer.code}</span>
            </Field>
            <Field label={t.period}>{financeMonth(inv.period)}</Field>
            <Field label={t.issuedOn}>{financeDate(inv.issuedOn)}</Field>
            <Field label={t.dueOn}>{financeDate(inv.dueOn)}</Field>
            <Field label={t.total}>
              <strong data-testid="invoice-total">{financeAmount(inv.total, inv.currency)}</strong>
            </Field>
            <Field label={t.variableSymbol}>
              <span className="font-mono">{inv.variableSymbol}</span>
            </Field>
          </FieldList>
          <p className="mt-3 text-xs text-stone-500">
            {t.issuedBy(formatDateTimeCs(inv.issuedAt), inv.issuedByName)}
          </p>
        </Card>
        <Card title={t.lines}>
          <div className="relative overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="invoice-lines">
              <thead className="text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="py-2 pr-4">{t.hotels}</th>
                  <th className="py-2 pr-4">{t.rooms}</th>
                  <th className="py-2 pr-4">{t.unitPrice}</th>
                  <th className="py-2 text-right">{t.amount}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {inv.lines.map((l) => (
                  <tr key={l.lineNo}>
                    <td className="py-2 pr-4">
                      {l.hotel.name}{' '}
                      <span className="font-mono text-xs text-stone-500">{l.agreementCode}</span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{l.billedRooms}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {financeAmount(l.unitPrice, inv.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {financeAmount(l.amount, inv.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={t.payment}>
          <FieldList>
            <Field label={t.account}>{inv.payment.account ?? '—'}</Field>
            <Field label={t.iban}>
              <span className="font-mono">{inv.payment.iban}</span>
            </Field>
            <Field label={t.amount}>
              {financeAmount(inv.payment.amount, inv.payment.currency)}
            </Field>
            <Field label={t.variableSymbol}>
              <span className="font-mono">{inv.payment.variableSymbol}</span>
            </Field>
            <Field label={t.pdfHash}>
              <span className="break-all font-mono text-xs">{inv.pdfSha256}</span>
            </Field>
          </FieldList>
        </Card>
        {canCancel && (
          <Card title={t.cancel}>
            <CancelInvoiceForm number={inv.number} />
          </Card>
        )}
      </div>
    </>
  );
}
