import {
  bankStatusSchema,
  billingAgreementSchema,
  billingCustomerSchema,
  financeDocumentPageSchema,
  invoicesOverviewSchema,
  issuerSettingsSchema,
  type PermissionCode,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { z } from 'zod';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { Card, CardLink, Notice, Stat } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { FINANCE_PERMISSIONS } from '@/lib/navigation';
import { hasPermission, requireAnyPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.overview;

/**
 * A block's source, or null when it did not answer (Finance or the core down, an unexpected
 * answer): the block then says "unavailable" — never 0. Navigation (sign-in, forbidden, not found)
 * is passed on.
 */
async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e && typeof e === 'object' && 'digest' in e) throw e;
    return null;
  }
}
const skipped = Promise.resolve(undefined);

/** The amount under a count, on its own line (it never runs out of its box). */
const Remaining = ({ children }: { children: React.ReactNode }) => (
  <span className="mt-0.5 block text-sm font-normal whitespace-normal text-stone-500">
    {children}
  </span>
);

const pragueDay = (iso: string) =>
  financeDate(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(iso)),
  );

/**
 * Přehled Financí (doc 042): what waits for payment, what needs completing and where to go on —
 * each block only with its own permission and only from a real answer (doc 042 §2): the invoice
 * sums the database computes (no list loaded), the incomplete received documents (a page's
 * total), the bank connection, and the next set-up steps while any is missing. Nothing is created
 * here and nothing blocks other work.
 */
export default async function FinanceOverviewPage() {
  const me = await requireAnyPermission(FINANCE_PERMISSIONS);
  const can = (p: PermissionCode) => hasPermission(me, p);
  const [sums, documents, bank, issuer, customers, agreements] = await Promise.all([
    can('finance:invoices_read')
      ? settle(apiGet('admin/finance/invoices/overview', invoicesOverviewSchema))
      : skipped,
    can('finance:documents_read')
      ? settle(apiGet('admin/finance/documents', financeDocumentPageSchema, { incomplete: 'true' }))
      : skipped,
    can('finance:bank_read')
      ? settle(apiGet('admin/finance/bank/status', bankStatusSchema))
      : skipped,
    can('finance:issuer_manage')
      ? settle(apiGet('admin/finance/issuer', issuerSettingsSchema))
      : skipped,
    can('finance:billing_read')
      ? settle(apiGet('admin/finance/billing/customers', z.array(billingCustomerSchema)))
      : skipped,
    can('finance:billing_read')
      ? settle(apiGet('admin/finance/billing/agreements', z.array(billingAgreementSchema)))
      : skipped,
  ]);

  // Set-up steps the user can see; done only from a real answer (unknown = not shown as done).
  const steps = [
    issuer !== undefined && {
      id: 'issuer' as const,
      done: issuer ? issuer.current !== null && issuer.defaults.length > 0 : null,
      href: '/finance/settings/company',
      allowed: true,
    },
    customers !== undefined && {
      id: 'customer' as const,
      done: customers ? customers.length > 0 : null,
      href: '/finance/billing?new=customer#customers',
      allowed: can('finance:billing_manage'),
    },
    agreements !== undefined && {
      id: 'agreement' as const,
      done: agreements ? agreements.length > 0 : null,
      href: '/finance/billing?new=agreement#agreements',
      allowed: can('finance:billing_manage'),
    },
  ].filter((s) => !!s);
  const setupComplete = steps.every((s) => s.done === true);

  return (
    <>
      <FinanceHeader active="overview" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {!setupComplete && (
          <Card title={t.nextSteps} testId="finance-next-steps">
            <p className="mb-3 text-xs text-stone-500">{t.nextStepsHelp}</p>
            <ol className="flex flex-col gap-2 text-sm">
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  data-testid={`step-${s.id}`}
                  data-done={s.done === true}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                      s.done ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-700',
                    )}
                  >
                    {s.done ? '✓' : i + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{t.steps[s.id]}</span>
                  <span className="text-xs text-stone-500">
                    {s.done === null ? t.unavailable : s.done ? t.done : t.todo}
                  </span>
                  {s.done === false && s.allowed && (
                    <CardLink href={s.href}>{t.stepLinks[s.id]}</CardLink>
                  )}
                </li>
              ))}
              {can('finance:invoices_test') && can('finance:billing_read') && (
                <li
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  data-testid="step-invoice"
                >
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-700"
                  >
                    {steps.length + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{t.steps.invoice}</span>
                  <CardLink href="/finance/invoices/new">{t.stepLinks.invoice}</CardLink>
                </li>
              )}
            </ol>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {sums !== undefined && (
            <Card
              title={t.invoices}
              testId="overview-invoices"
              action={<CardLink href="/finance/invoices">{t.toInvoices}</CardLink>}
            >
              {sums === null ? (
                <p className="text-sm text-stone-600">{t.unavailable}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {sums.invoices.length === 0 ? (
                      <Stat label={t.openNone} value="0" testId="overview-open-none" />
                    ) : (
                      sums.invoices.flatMap((c) => [
                        <Stat
                          key={`${c.currency}-open`}
                          label={t.open(c.currency)}
                          value={
                            <>
                              {t.count(c.open.count)}
                              <Remaining>
                                {t.remaining(financeAmount(c.open.remaining, c.currency))}
                              </Remaining>
                            </>
                          }
                          href="/finance/invoices"
                          testId={`overview-open-${c.currency}`}
                        />,
                        <Stat
                          key={`${c.currency}-overdue`}
                          label={t.overdue(c.currency)}
                          value={
                            <>
                              {t.count(c.overdue.count)}
                              {c.overdue.count > 0 && (
                                <Remaining>
                                  {t.remaining(financeAmount(c.overdue.remaining, c.currency))}
                                </Remaining>
                              )}
                            </>
                          }
                          tone={c.overdue.count > 0 ? 'warning' : 'neutral'}
                          href="/finance/invoices"
                          testId={`overview-overdue-${c.currency}`}
                        />,
                      ])
                    )}
                  </div>
                  <Notice tone="info">{t.testInvoices}</Notice>
                </div>
              )}
            </Card>
          )}

          {sums !== undefined && (
            <Card
              title={t.payments}
              testId="overview-payments"
              action={<CardLink href="/finance/payments">{t.toPayments}</CardLink>}
            >
              {sums === null ? (
                <p className="text-sm text-stone-600">{t.unavailable}</p>
              ) : (
                <Stat
                  label={t.toReview}
                  value={sums.paymentsToReview}
                  tone={sums.paymentsToReview > 0 ? 'warning' : 'neutral'}
                  href="/finance/payments"
                  testId="overview-to-review"
                />
              )}
            </Card>
          )}

          {documents !== undefined && (
            <Card
              title={t.documents}
              testId="overview-documents"
              action={<CardLink href="/finance/documents">{t.toDocuments}</CardLink>}
            >
              {documents === null ? (
                <p className="text-sm text-stone-600">{t.unavailable}</p>
              ) : (
                <Stat
                  label={t.incomplete}
                  value={documents.total}
                  tone={documents.total > 0 ? 'warning' : 'neutral'}
                  href="/finance/documents?incomplete=true"
                  testId="overview-incomplete"
                />
              )}
            </Card>
          )}

          {bank !== undefined && (
            <Card
              title={t.bank}
              testId="overview-bank"
              action={<CardLink href="/finance/bank">{t.toBank}</CardLink>}
            >
              {bank === null ? (
                <p className="text-sm text-stone-600">{t.unavailable}</p>
              ) : bank.environment === null ? (
                <p className="text-sm text-stone-600">{t.bankNotConnected}</p>
              ) : (
                <div className="flex flex-col gap-2 text-sm">
                  {bank.environment !== 'PRODUCTION' && (
                    <Notice>{financeCs.bank.environment[bank.environment]}</Notice>
                  )}
                  <ul className="flex flex-col gap-1">
                    {bank.accounts.map((a) => {
                      const account = `${a.accountNumber}/${a.currency}`;
                      return (
                        <li key={account}>
                          {a.lastSuccess?.finishedAt
                            ? t.bankLast(account, pragueDay(a.lastSuccess.finishedAt))
                            : t.bankNever(account)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
