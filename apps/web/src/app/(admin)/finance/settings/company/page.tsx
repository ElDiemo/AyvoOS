import { issuerSettingsSchema, type IssuerBankAccount } from '@ayvo/types';
import { AccountForm, DefaultAccountForm, IssuerForm } from '@/components/finance/issuer-forms';
import { Card, EmptyState, Notice } from '@/components/ui';
import { FinanceHeader } from '@/components/finance/finance-header';
import { issuerCs as t } from '@/i18n/cs/finance-issuer';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

const when = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const domestic = (a: IssuerBankAccount['current']['account']) =>
  a.accountNumber && a.bankCode
    ? `${a.accountPrefix ? `${a.accountPrefix.replace(/^0+/, '')}-` : ''}${a.accountNumber}/${a.bankCode}`
    : null;

/**
 * Naše firma a bankovní účty (N3A-2a, doc 040 §8): finance:issuer_manage only (ADMIN). The
 * issuer's details, the accounts printed on invoices and the default per currency — each change a
 * new version with a reason, every form edited from the version it shows; what still blocks a
 * live invoice. Not the bank connection (Bankovní pohyby) and never its secrets.
 */
export default async function CompanySettingsPage() {
  await requirePermission('finance:issuer_manage');
  const s = await apiGet('admin/finance/issuer', issuerSettingsSchema);
  return (
    <>
      <FinanceHeader active="settings" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        <Card title={t.readiness.title} testId="issuer-readiness">
          <ul className="flex flex-col gap-2 text-sm">
            {s.readiness.map((r) =>
              r.gaps.length === 0 ? (
                <li key={r.currency}>{t.readiness.ok(r.currency)}</li>
              ) : (
                <li key={r.currency}>
                  <Notice>
                    {r.currency}: {r.gaps.map((g) => t.readiness.gaps[g]).join(', ')}
                  </Notice>
                </li>
              ),
            )}
          </ul>
          <p className="mt-3 text-xs text-stone-500">{t.readiness.note}</p>
        </Card>

        <Card title={t.issuer.title} testId="issuer-card">
          {!s.current && <Notice tone="info">{t.issuer.none}</Notice>}
          <IssuerForm key={s.current?.version ?? 0} current={s.current} />
          {s.versions.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-stone-600">{t.issuer.history}</summary>
              <ul className="mt-2 divide-y divide-stone-100" data-testid="issuer-history">
                {s.versions.map((v) => (
                  <li key={v.version} className="py-2">
                    <span className="font-medium">{t.issuer.version(v.version)}</span> ·{' '}
                    {when(v.recordedAt)} · {v.recordedByName} — {v.reason}
                    <span className="block text-stone-500 wrap-anywhere">
                      {v.issuer.legalName}, IČO {v.issuer.companyId},{' '}
                      {t.issuer.vatStatus[v.issuer.vatStatus]}
                      {v.issuer.vatId ? ` (${v.issuer.vatId})` : ''}, {v.issuer.email}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>

        <Card title={t.accounts.title} testId="issuer-accounts">
          {s.accounts.length === 0 ? (
            <EmptyState>{t.accounts.none}</EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {s.accounts.map((a) => (
                <li
                  key={a.code}
                  className="rounded-md border border-stone-200 p-3 text-sm"
                  data-testid="issuer-account"
                >
                  <span className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">
                      {a.code} · {a.current.account.label} · {a.current.account.currency}
                    </span>
                    <span className="text-stone-500">{t.accounts.status[a.current.status]}</span>
                  </span>
                  <span className="mt-1 block font-mono text-xs wrap-anywhere">
                    {domestic(a.current.account) ?? ''} {a.current.account.iban}
                    {a.current.account.bic ? ` · ${a.current.account.bic}` : ''}
                  </span>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-stone-600">{t.accounts.edit}</summary>
                    <div className="mt-3">
                      <AccountForm key={a.current.version} account={a} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">{t.accounts.add}</summary>
            <div className="mt-3">
              <AccountForm />
            </div>
          </details>
        </Card>

        <Card title={t.defaults.title} testId="issuer-defaults">
          <ul className="flex flex-col gap-4 text-sm">
            {s.readiness.map((r) => {
              const d = s.defaults.find((x) => x.currency === r.currency) ?? null;
              return (
                <li key={r.currency} className="flex flex-col gap-2">
                  <span>
                    {d
                      ? t.defaults.current(r.currency, d.accountCode)
                      : t.defaults.none(r.currency)}
                  </span>
                  <DefaultAccountForm
                    key={`${r.currency}-${d?.revision ?? 0}`}
                    currency={r.currency}
                    accounts={s.accounts}
                    currentCode={d?.accountCode ?? null}
                    revision={d?.revision ?? null}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
