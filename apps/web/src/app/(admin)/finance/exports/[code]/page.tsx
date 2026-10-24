import { API_BASE_PATH, accountingExportDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { ExportLines } from '@/components/finance/export-lines';
import { fileSize, financeDate } from '@/components/finance/finance-format';
import { buttonClass, Card, Field, FieldList, Notice, PageHeader } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { ApiError, apiGet } from '@/lib/api';
import { siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.exports;

/** One export: what was handed over (per document version) and what changed afterwards. */
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
  const zone = await siteTimeZone();
  const when = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: zone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(doc.createdAt));
  return (
    <>
      <PageHeader
        back={{ href: '/finance/exports', label: t.back }}
        title={`${doc.code} · ${financeDate(doc.periodFrom)} – ${financeDate(doc.periodTo)}`}
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
            <Field label="ZIP">
              {fileSize(doc.byteSize)} ·{' '}
              <span className="font-mono text-xs">SHA-256 {doc.sha256.slice(0, 16)}…</span>
            </Field>
          </FieldList>
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
