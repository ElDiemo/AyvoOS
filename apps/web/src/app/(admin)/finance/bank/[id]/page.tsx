import { bankPaymentCandidateSchema } from '@ayvo/types';
import { notFound, redirect } from 'next/navigation';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { AllocatePaymentForm } from '@/components/finance/payment-forms';
import { buttonClass, Card, Field, FieldList, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { ApiError, apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.bankAllocate;
const p = financeCs.payments;

/**
 * An incoming bank transaction allocated to an invoice by hand (owner 2026-11-02: a hotel paid
 * with a wrong VS). Other income is never a task, so this page is opened only from the bank list.
 * A transaction already recorded as a payment opens that payment — never a second one.
 */
export default async function BankAllocatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ invoice?: string }>;
}) {
  await requirePermission('finance:payments_manage');
  const { id } = await params;
  const { invoice } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await apiGet(`admin/finance/payments/bank/${id}`, bankPaymentCandidateSchema, {
    q: invoice,
  }).catch((e: unknown) => {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  });
  if (c.paymentCode) redirect(`/finance/payments/${c.paymentCode}`);
  const f = p.detailFacts;
  return (
    <>
      <FinanceHeader
        active="bank"
        view="bank"
        title={t.title}
        subtitle={t.subtitle}
        back={{ href: '/finance/bank', label: t.back }}
      />
      <div className="flex flex-col gap-6" data-testid="bank-allocate">
        <Card>
          <FieldList>
            <Field label={f.amount}>{financeAmount(c.amount, c.currency)}</Field>
            <Field label={f.bookedOn}>{financeDate(c.bookedOn)}</Field>
            <Field label={f.variableSymbol}>
              <span className="font-mono">{c.variableSymbol ?? '—'}</span>
            </Field>
            <Field label={f.counterparty}>{c.counterpartyName ?? '—'}</Field>
            <Field label={f.account}>{c.counterpartyAccount ?? '—'}</Field>
            <Field label={f.message}>{c.message ?? '—'}</Field>
          </FieldList>
        </Card>
        <Card title={p.allocateTitle}>
          {c.limited && <p className="mb-2 text-xs text-stone-500">{p.openLimited}</p>}
          <form className="mb-3 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex min-w-0 flex-1 flex-col gap-1 font-medium">
              {p.invoiceSearch}
              <input
                name="invoice"
                defaultValue={invoice ?? ''}
                maxLength={40}
                className={inputClass}
              />
            </label>
            <button type="submit" className={buttonClass.secondary}>
              {p.search}
            </button>
          </form>
          {c.invoices.length === 0 ? (
            <p className="text-sm text-stone-500">{p.noOpen}</p>
          ) : (
            <AllocatePaymentForm
              payment={{ code: 'bank', suggestions: [], unallocated: c.amount }}
              bankTransactionId={c.transactionId}
              openInvoices={c.invoices.map((i) => i.number)}
            />
          )}
        </Card>
      </div>
    </>
  );
}
