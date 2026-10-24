import {
  API_BASE_PATH,
  financeDocumentDetailSchema,
  financeSupplierSchema,
  type FinanceDocumentEvent,
} from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DocumentActions } from '@/components/finance/document-actions';
import { fileSize, financeAmount, financeDate } from '@/components/finance/finance-format';
import { buttonClass, Card, Field, FieldList, Notice, PageHeader } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { ApiError, apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** One received document (doc 039, N1): metadata, the original, history; correct or void. */
export default async function FinanceDocumentPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^FD-\d{6,}$/.test(code)) notFound();
  const doc = await apiGet(`admin/finance/documents/${code}`, financeDocumentDetailSchema).catch(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    },
  );
  const me = await currentUser();
  const canManage = hasPermission(me, 'finance:documents_manage') && doc.status === 'ACTIVE';
  const [suppliers, zone] = await Promise.all([
    canManage ? apiGet('admin/finance/suppliers', z.array(financeSupplierSchema)) : [],
    siteTimeZone(),
  ]);
  const when = (iso: string) =>
    new Intl.DateTimeFormat('cs-CZ', {
      timeZone: zone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(iso));
  const fieldName = (k: string) => (t.fields as Record<string, string>)[k] ?? k;
  const shown = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return t.detail.empty;
    if (k === 'kind') return t.kinds[v as keyof typeof t.kinds] ?? String(v);
    if (k === 'status') return t.status[v as keyof typeof t.status] ?? String(v);
    if (k === 'supplierId') return v === doc.supplier.id ? doc.supplier.name : String(v);
    if (/On$/.test(k)) return financeDate(String(v));
    return String(v);
  };

  return (
    <>
      <PageHeader
        back={{ href: '/finance/documents', label: t.detail.back }}
        title={`${doc.code} · ${t.kinds[doc.kind]} ${doc.documentNumber}`}
        subtitle={doc.supplier.name}
        actions={
          <a
            href={`${API_BASE_PATH}/admin/finance/documents/${doc.code}/content`}
            className={buttonClass.secondary}
            data-testid="finance-download"
          >
            {t.detail.download}
          </a>
        }
      />
      <div className="flex flex-col gap-6">
        {doc.status === 'VOIDED' && <Notice>{t.detail.voided}</Notice>}
        <Card testId="finance-document">
          <FieldList>
            <Field label={t.fields.status}>{t.status[doc.status]}</Field>
            <Field label={t.fields.supplier}>{doc.supplier.name}</Field>
            <Field label={t.fields.kind}>{t.kinds[doc.kind]}</Field>
            <Field label={t.fields.documentNumber}>{doc.documentNumber}</Field>
            <Field label={t.fields.issuedOn}>{financeDate(doc.issuedOn)}</Field>
            <Field label={t.fields.taxPointOn}>{financeDate(doc.taxPointOn)}</Field>
            <Field label={t.fields.dueOn}>{financeDate(doc.dueOn)}</Field>
            <Field label={t.fields.amount}>{financeAmount(doc.totalAmount, doc.currency)}</Field>
            <Field label={t.fields.description}>{doc.description ?? t.detail.empty}</Field>
            <Field label={t.fields.file}>
              {doc.originalFilename} · {fileSize(doc.byteSize)} ·{' '}
              <span className="font-mono text-xs">SHA-256 {doc.sha256.slice(0, 16)}…</span>
            </Field>
            <Field label={t.fields.created}>
              {when(doc.createdAt)} · {doc.createdBy}
            </Field>
            <Field label={t.fields.version}>{doc.version}</Field>
          </FieldList>
          {canManage && (
            <div className="mt-6 border-t border-stone-100 pt-5">
              <DocumentActions doc={doc} suppliers={suppliers} />
            </div>
          )}
        </Card>
        <Card title={t.detail.history} testId="finance-history">
          <ol className="flex flex-col gap-4">
            {[...doc.history].reverse().map((e: FinanceDocumentEvent) => (
              <li key={e.version} className="text-sm">
                <p className="font-medium">
                  {t.detail.events[e.type]} · {when(e.occurredAt)} · {e.actor}
                </p>
                {e.reason && <p className="text-stone-600">{e.reason}</p>}
                {Object.keys(e.changes).length > 0 && (
                  <ul className="mt-1 text-stone-600">
                    {Object.entries(e.changes).map(([k, [before, after]]) => (
                      <li key={k}>
                        {fieldName(k)}: {shown(k, before)} → {shown(k, after)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
