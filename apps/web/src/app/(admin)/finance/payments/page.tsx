import { invoiceSummarySchema, paymentsPageSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import {
  AllocatePaymentForm,
  ImportBankButton,
  SimulateStatementForm,
} from '@/components/finance/payment-forms';
import { Card, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.payments;

/**
 * Platby a přiřazení (N3B-2, doc 041 §8; a view of Banka a platby, doc 042): incoming payments,
 * their matching and allocations. The list comes first; recording payments from the bank
 * transactions already read is the one action above it, the DEV simulation a closed block below
 * (never in production). Each payment is an anchor (#P-…) for the invoice detail's links.
 */
export default async function PaymentsPage() {
  const me = await requirePermission('finance:invoices_read');
  const canManage = hasPermission(me, 'finance:payments_manage');
  const [page, invoices] = await Promise.all([
    apiGet('admin/finance/payments', paymentsPageSchema),
    apiGet('admin/finance/invoices', z.array(invoiceSummarySchema)),
  ]);
  const open = (currency: string) =>
    invoices
      .filter(
        (i) => i.status === 'VALID' && i.currency === currency && i.paymentState.state !== 'PAID',
      )
      .map((i) => i.number);
  return (
    <>
      <FinanceHeader active="bank" view="payments" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {/* Where payments come from, and (finance:payments_manage) the one action that records them. */}
        <div
          className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 text-sm shadow-sm"
          data-testid="payments-from-bank"
        >
          <p className="text-stone-600">
            {t.fromBank}{' '}
            <Link href="/finance/bank" className="underline">
              {financeCs.bank.title}
            </Link>
            .
          </p>
          {canManage && <ImportBankButton />}
        </div>
        <Card testId="payments">
          {page.payments.length === 0 ? (
            <p className="py-2 text-sm text-stone-600">{t.empty}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {page.payments.map((p) => (
                <li
                  key={p.code}
                  id={p.code}
                  className="flex scroll-mt-24 flex-col gap-2 py-3 target:bg-amber-50"
                  data-testid={`payment-${p.code}`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-mono">{p.code}</span>
                    <span className="font-semibold tabular-nums">
                      {financeAmount(p.amount, p.currency)}
                    </span>
                    <span>{financeDate(p.bookedOn)}</span>
                    <span>
                      {t.variableSymbol} {p.variableSymbol ?? '—'}
                    </span>
                    <span className="text-stone-500">
                      {t.source[p.source]} · <span className="font-mono">{p.reference}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {(() => {
                      // The matching result is history; once a person allocated it, it is resolved.
                      const review =
                        p.matchResult !== 'MATCHED' && p.matchResult !== 'PARTIAL_OVERPAYMENT';
                      const resolved = review && p.state === 'ALLOCATED';
                      return (
                        <span
                          className={review && !resolved ? 'text-amber-800' : 'text-emerald-800'}
                          data-testid={`payment-${p.code}-result`}
                        >
                          {resolved
                            ? t.resolved(t.result[p.matchResult]!)
                            : t.result[p.matchResult]}
                        </span>
                      );
                    })()}
                    <span className="font-medium" data-testid={`payment-${p.code}-state`}>
                      {t.state[p.state]}
                    </span>
                    {p.state !== 'ALLOCATED' && (
                      <span>{t.unallocated(financeAmount(p.unallocated, p.currency))}</span>
                    )}
                  </div>
                  {p.bankChangedSinceRecorded && (
                    <p
                      className="text-sm text-red-800"
                      data-testid={`payment-${p.code}-bank-changed`}
                    >
                      {t.bankChanged}
                    </p>
                  )}
                  {p.allocations.length > 0 && (
                    <ul className="text-stone-600">
                      {p.allocations.map((a, i) => (
                        <li key={i}>
                          <Link href={`/finance/invoices/${a.invoiceNumber}`} className="underline">
                            {t.allocated(
                              a.invoiceNumber,
                              financeAmount(a.amount, p.currency),
                              t.kind[a.kind]!,
                            )}
                          </Link>
                          {a.reason ? ` – ${a.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.suggestions.length > 0 && (
                    <p
                      className="text-xs text-stone-500"
                      data-testid={`payment-${p.code}-suggestions`}
                    >
                      {t.suggestions} {p.suggestions.join(', ')}
                    </p>
                  )}
                  {canManage && p.state !== 'ALLOCATED' && open(p.currency).length > 0 && (
                    <AllocatePaymentForm payment={p} openInvoices={open(p.currency)} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {canManage && page.simulationAvailable && (
          <details
            className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm"
            data-testid="payments-simulation"
          >
            <summary className="cursor-pointer font-medium">{t.simulateTitle}</summary>
            <div className="mt-4 flex flex-col gap-4">
              <Notice tone="info">{t.simulationNote}</Notice>
              <SimulateStatementForm />
            </div>
          </details>
        )}
      </div>
    </>
  );
}
