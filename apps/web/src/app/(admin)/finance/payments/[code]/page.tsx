import { incomingPaymentSchema, paymentOpenInvoicesSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { AllocatePaymentForm } from '@/components/finance/payment-forms';
import { buttonClass, Card, Field, FieldList, inputClass, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { ApiError, apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.payments;

/** One payment (doc 044 U4): its facts, allocations and, with the permission, a new allocation. */
export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ invoice?: string }>;
}) {
  const me = await requirePermission('finance:invoices_read');
  const { code } = await params;
  const { invoice } = await searchParams;
  if (!/^PP-\d{6,}$/.test(code)) notFound();
  const p = await apiGet(`admin/finance/payments/${code}`, incomingPaymentSchema).catch(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    },
  );
  const canAllocate = hasPermission(me, 'finance:payments_manage') && p.state !== 'ALLOCATED';
  const open = canAllocate
    ? await apiGet(`admin/finance/payments/${code}/open-invoices`, paymentOpenInvoicesSchema, {
        q: invoice,
      })
    : null;
  const f = t.detailFacts;
  const review = p.matchResult !== 'MATCHED' && p.matchResult !== 'PARTIAL_OVERPAYMENT';
  const resolved = review && p.state === 'ALLOCATED';
  return (
    <>
      <FinanceHeader
        active="bank"
        view="payments"
        title={p.code}
        subtitle={financeAmount(p.amount, p.currency)}
        back={{ href: '/finance/payments', label: t.back }}
      />
      <div className="flex flex-col gap-6" data-testid={`payment-${p.code}`}>
        {p.bankChangedSinceRecorded && (
          <Notice tone="warning">
            <span data-testid={`payment-${p.code}-bank-changed`}>{t.bankChanged}</span>
          </Notice>
        )}
        <Card>
          <FieldList>
            <Field label={t.allocationsTitle}>
              <strong data-testid={`payment-${p.code}-state`}>{t.state[p.state]}</strong>
              {p.state !== 'ALLOCATED' && (
                <span> · {t.unallocated(financeAmount(p.unallocated, p.currency))}</span>
              )}
            </Field>
            <Field label={f.source}>
              <span
                className={review && !resolved ? 'text-amber-800' : undefined}
                data-testid={`payment-${p.code}-result`}
              >
                {resolved ? t.resolved(t.result[p.matchResult]!) : t.result[p.matchResult]}
              </span>
            </Field>
            <Field label={f.amount}>{financeAmount(p.amount, p.currency)}</Field>
            <Field label={f.bookedOn}>{financeDate(p.bookedOn)}</Field>
            <Field label={f.variableSymbol}>
              <span className="font-mono">{p.variableSymbol ?? '—'}</span>
            </Field>
            <Field label={f.counterparty}>{p.counterpartyName ?? '—'}</Field>
            <Field label={f.account}>{p.counterpartyAccount ?? '—'}</Field>
            <Field label={f.message}>{p.message ?? '—'}</Field>
          </FieldList>
        </Card>
        <Card title={t.allocationsTitle} testId="payment-allocations">
          {p.allocations.length === 0 ? (
            <p className="text-sm text-stone-500">{t.noAllocations}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {p.allocations.map((a, i) => (
                <li key={i} className="py-2">
                  <Link href={`/finance/invoices/${a.invoiceNumber}`} className="underline">
                    {t.allocated(
                      a.invoiceNumber,
                      financeAmount(a.amount, p.currency),
                      t.kind[a.kind]!,
                    )}
                  </Link>
                  {a.reason ? ` – ${a.reason}` : ''}
                  <span className="block text-xs text-stone-500">
                    {formatDateTimeCs(a.recordedAt)}, {a.recordedByName}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {open && (
          <Card title={t.allocateTitle}>
            {p.suggestions.length > 0 && (
              <p
                className="mb-2 text-xs text-stone-500"
                data-testid={`payment-${p.code}-suggestions`}
              >
                {t.suggestions} {p.suggestions.join(', ')}
              </p>
            )}
            {open.limited && <p className="mb-2 text-xs text-stone-500">{t.openLimited}</p>}
            <form className="mb-3 flex flex-wrap items-end gap-2 text-sm">
              <label className="flex min-w-0 flex-1 flex-col gap-1 font-medium">
                {t.invoiceSearch}
                <input
                  name="invoice"
                  defaultValue={invoice ?? ''}
                  maxLength={40}
                  className={inputClass}
                />
              </label>
              <button type="submit" className={buttonClass.secondary}>
                {t.search}
              </button>
            </form>
            {open.invoices.length === 0 ? (
              <p className="text-sm text-stone-500">{t.noOpen}</p>
            ) : (
              <AllocatePaymentForm payment={p} openInvoices={open.invoices.map((i) => i.number)} />
            )}
          </Card>
        )}
        <Card title={f.source}>
          <FieldList>
            <Field label={f.source}>{t.source[p.source]}</Field>
            <Field label={f.reference}>
              <span className="break-all font-mono text-xs">{p.reference}</span>
            </Field>
            <Field label={f.recorded}>
              {formatDateTimeCs(p.recordedAt)}, {p.recordedByName}
            </Field>
          </FieldList>
        </Card>
      </div>
    </>
  );
}
