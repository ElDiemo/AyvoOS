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
import { Card, EmptyState, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.payments;

/** Platby (N3B-2, doc 041 §8): incoming payments, their matching and allocations. */
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
      <FinanceHeader active="payments" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {canManage && page.simulationAvailable && (
          <Card title={t.simulateTitle}>
            <div className="flex flex-col gap-4">
              <Notice tone="info">{t.simulationNote}</Notice>
              <SimulateStatementForm />
            </div>
          </Card>
        )}
        {canManage && (
          <Card>
            <ImportBankButton />
          </Card>
        )}
        <Card testId="payments">
          {page.payments.length === 0 ? (
            <EmptyState>{t.empty}</EmptyState>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {page.payments.map((p) => (
                <li
                  key={p.code}
                  className="flex flex-col gap-2 py-3"
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
                    <span
                      className={
                        p.matchResult === 'MATCHED' ? 'text-emerald-800' : 'text-amber-800'
                      }
                      data-testid={`payment-${p.code}-result`}
                    >
                      {t.result[p.matchResult]}
                    </span>
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
      </div>
    </>
  );
}
