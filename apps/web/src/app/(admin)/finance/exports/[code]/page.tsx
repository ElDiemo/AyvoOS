import { API_BASE_PATH, accountingExportDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { ExportLines } from '@/components/finance/export-lines';
import { fileSize, financeDate, financeMonth } from '@/components/finance/finance-format';
import { HandOverForm } from '@/components/finance/hand-over-form';
import { buttonClass, Card, Field, FieldList, Notice, PageHeader } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { ApiError, apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.exports;

/**
 * One export: its content per document version, its history (generated, downloaded, handed over
 * to the accountant — recorded by hand), and what changed against it afterwards.
 */
export default async function AccountingExportPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!/^AE-\d{6,}$/.test(code)) notFound();
  const doc = await apiGet(`admin/finance/exports/${code}`, accountingExportDetailSchema).catch(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    },
  );
  const [zone, me] = await Promise.all([siteTimeZone(), currentUser()]);
  const canHandOver = hasPermission(me, 'finance:exports_manage') && !doc.handedOverOn;
  const format = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: zone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const when = format.format(new Date(doc.createdAt));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  return (
    <>
      <PageHeader
        back={{ href: '/finance/exports', label: t.back }}
        title={`${doc.code} · ${financeMonth(doc.handoverMonth)}`}
        subtitle={t.modes[doc.mode]}
        actions={
          <a
            href={`${API_BASE_PATH}/admin/finance/exports/${doc.code}/content`}
            className={buttonClass.primary}
            data-testid="export-download"
          >
            {t.download}
          </a>
        }
      />
      <div className="flex flex-col gap-6">
        <Card testId="export-detail">
          <FieldList>
            <Field label={t.columns.count}>{doc.documentCount}</Field>
            <Field label={t.columns.created}>
              {when} · {doc.createdBy}
            </Field>
            {doc.note && <Field label={t.note}>{doc.note}</Field>}
            <Field label={t.handOver.title}>
              {doc.handedOverOn ? t.handedOver(financeDate(doc.handedOverOn)) : t.notHandedOver}
            </Field>
            <Field label="ZIP">
              {fileSize(doc.byteSize)} ·{' '}
              <span className="font-mono text-xs">SHA-256 {doc.sha256.slice(0, 16)}…</span>
            </Field>
          </FieldList>
        </Card>
        {canHandOver && (
          <Card title={t.handOver.title}>
            <HandOverForm code={doc.code} today={today} />
          </Card>
        )}
        <Card title={t.events.title} testId="export-events">
          <ol className="flex flex-col gap-2 text-sm">
            {doc.events.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{t.events[e.type]}</span> ·{' '}
                {format.format(new Date(e.occurredAt))} · {e.actor}
                {e.handedOverOn && ` · ${financeDate(e.handedOverOn)}`}
                {e.note && <span className="text-stone-600"> — {e.note}</span>}
              </li>
            ))}
          </ol>
        </Card>
        <Card title={t.later} testId="export-later">
          {doc.laterChanges.length === 0 ? (
            <p className="text-sm text-stone-600">{t.laterNone}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Notice>{t.laterHelp}</Notice>
              <ExportLines lines={doc.laterChanges} />
            </div>
          )}
        </Card>
        <Card title={t.lines} testId="export-lines">
          <ExportLines lines={doc.lines} />
        </Card>
      </div>
    </>
  );
}
