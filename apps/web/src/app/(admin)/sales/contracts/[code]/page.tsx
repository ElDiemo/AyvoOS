import {
  contractDraftCodeSchema,
  contractDraftDetailSchema,
  contractDraftPrefillSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  LinkHotel,
  RemoveOrRestore,
  UploadSigned,
} from '@/components/contracts/contract-draft-actions';
import { ContractDraftWizard } from '@/components/contracts/contract-draft-wizard';
import { SuccessNote } from '@/components/catalog/form-kit';
import { SalesHeader } from '@/components/sales/sales-header';
import { buttonClass, Card, Field, FieldList, Notice } from '@/components/ui';
import { contractsCs as t } from '@/i18n/cs/contracts';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** "1200.50" → "1 200,50": the exact decimal, only regrouped. */
const czAmount = (v: string) => {
  const [whole, fraction = ''] = v.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction.padEnd(2, '0')}`;
};
const czDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};

/**
 * One contract draft (doc 045 §2): the current revision and its printable PDF, editing (a new
 * revision with a reason), removal with confirmation and restore, the hand link to a hotel, every
 * revision's PDF and the history. Access is checked by the API on every call (404 out of scope).
 */
export default async function ContractDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await requirePermission('sales:work');
  const { code } = await params;
  const { saved } = await searchParams;
  if (!contractDraftCodeSchema.safeParse(code).success) notFound();
  const d = await apiGet(`admin/contracts/drafts/${code}`, contractDraftDetailSchema);
  const current = d.revisions[0]!;
  const f = current.fields;
  const hotels = d.canLinkHotel
    ? (
        await apiGet(
          'admin/contracts/drafts/prefill',
          contractDraftPrefillSchema,
          d.prospect ? { prospect: d.prospect.code } : { hotel: d.hotel!.code },
        )
      ).hotels
    : [];
  const pdf = (revision: number) => `/api/admin/contracts/drafts/${code}/revisions/${revision}/pdf`;
  const back = d.prospect
    ? { href: `/sales/prospects/${d.prospect.code}`, label: d.prospect.name }
    : d.hotel && hasPermission(me, 'hotels:read')
      ? { href: `/hotels/${d.hotel.code}#navrhy-smluv`, label: d.hotel.name }
      : { href: '/sales/prospects', label: 'Akvizice' };
  return (
    <>
      <SalesHeader
        active="prospects"
        title={`${t.title}: ${d.counterpartyName}`}
        subtitle={
          <span className="flex flex-wrap gap-x-3">
            <span className="font-mono">{d.code}</span>
            <span>{t.detail.current(d.currentRevision)}</span>
          </span>
        }
        back={back}
        actions={
          <a
            href={pdf(d.currentRevision)}
            className={buttonClass.primary}
            data-testid="contract-download"
          >
            {t.detail.download}
          </a>
        }
      />
      <div className="flex flex-col gap-6">
        {saved && <SuccessNote>Návrh je uložený.</SuccessNote>}
        <Notice tone="warning">
          <span className="font-semibold">{t.mark}.</span> {t.workingText}
        </Notice>
        {d.removed && (
          <Notice tone="info">
            <span data-testid="contract-removed">{t.detail.removed(d.removeReason ?? '')}</span>
          </Notice>
        )}
        {d.hotelMismatch && (
          <Notice tone="warning">
            <span data-testid="contract-hotel-mismatch">{t.identity.detailMismatch}</span>
          </Notice>
        )}
        <Card title={t.detail.current(d.currentRevision)} testId="contract-current">
          <FieldList>
            <Field label={t.fields.counterpartyName}>{f.counterpartyName}</Field>
            <Field label={t.fields.counterpartyCompanyId}>{f.counterpartyCompanyId ?? '—'}</Field>
            <Field label={t.fields.hotelName}>
              {f.hotelName}, {f.hotelAddress}
            </Field>
            <Field label={t.fields.rooms}>{f.rooms}</Field>
            <Field label={t.fields.price}>
              <span data-testid="contract-price">
                {czAmount(f.pricePerRoomMonth)} {f.currency}
              </span>
            </Field>
            <Field label={t.fields.startOn}>{czDate(f.startOn)}</Field>
            <Field label={t.fields.billingTiming}>
              {t.timing[f.billingTiming]} · {t.fields.paymentTermsDays} {f.paymentTermsDays}
            </Field>
            <Field label={t.fields.holders}>
              <span data-testid="contract-holders">
                {t.detail.holdersLine(
                  t.holders[f.holders]!,
                  f.holdersOwnership ? t.ownership[f.holdersOwnership]! : null,
                )}
              </span>
            </Field>
            <Field label={t.detail.prospect}>
              {d.prospect ? (
                <Link href={`/sales/prospects/${d.prospect.code}`} className="underline">
                  {d.prospect.name}
                </Link>
              ) : (
                '—'
              )}
            </Field>
            <Field label={t.detail.hotel}>
              <span data-testid="contract-hotel">
                {d.hotel ? (
                  hasPermission(me, 'hotels:read') ? (
                    <Link href={`/hotels/${d.hotel.code}#navrhy-smluv`} className="underline">
                      {d.hotel.name}
                    </Link>
                  ) : (
                    d.hotel.name
                  )
                ) : (
                  t.detail.noHotel
                )}
              </span>
            </Field>
          </FieldList>
        </Card>

        <Card title={t.signed.title} testId="contract-signed">
          <p className="mb-3 text-xs text-stone-500">{t.signed.state}</p>
          {d.signed.length === 0 ? (
            <p className="text-sm text-stone-600">{t.signed.none}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm" data-testid="contract-signed-list">
              {d.signed.map((x) => (
                <li key={x.revision} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="font-medium">
                    {t.signed.entry(x.revision, czDate(x.signedOn))}
                  </span>
                  <span className="text-stone-600 wrap-anywhere">
                    {x.originalFilename} ·{' '}
                    {t.signed.uploaded(formatDateTimeCs(x.uploadedAt), x.uploadedByName)}
                  </span>
                  <a
                    href={`/api/admin/contracts/drafts/${code}/signed/${x.revision}`}
                    className="underline"
                    data-testid={`contract-signed-download-${x.revision}`}
                  >
                    {t.signed.download}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {d.canUploadSigned && (
            <details key={`upload-${d.version}`} className="mt-4">
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="contract-upload-open"
              >
                {t.signed.upload(d.currentRevision)}
              </summary>
              <div className="mt-3">
                <UploadSigned code={d.code} version={d.version} revision={d.currentRevision} />
              </div>
            </details>
          )}
        </Card>

        {!d.removed && (
          <Card title={t.detail.edit} testId="contract-edit">
            {/* Closed again after each saved revision (keyed by the version). */}
            <details key={d.version}>
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="contract-edit-open"
              >
                {t.detail.edit}
              </summary>
              <p className="my-3 text-xs text-stone-500">
                {d.signed.some((x) => x.revision === d.currentRevision)
                  ? t.signed.amendment
                  : t.detail.editHelp}
              </p>
              <ContractDraftWizard
                key={d.version}
                mode="revise"
                code={d.code}
                version={d.version}
                current={f}
                linkedHotel={d.hotelIdentity}
              />
            </details>
          </Card>
        )}

        {d.canLinkHotel && hotels.length > 0 && (
          <Card title={d.hotel ? t.link.correct : t.link.open} testId="contract-link">
            <LinkHotel
              key={d.version}
              code={d.code}
              version={d.version}
              hotels={hotels}
              draft={{ name: f.hotelName, address: f.hotelAddress }}
              linked={d.hotel?.code ?? null}
            />
          </Card>
        )}

        <Card title={t.detail.revisions} testId="contract-revisions">
          <ul className="divide-y divide-stone-100 text-sm">
            {d.revisions.map((r) => (
              <li key={r.revision} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-medium">{t.revisionShort(r.revision)}</span>
                <span className="text-stone-600">
                  {formatDateTimeCs(r.createdAt)} · {r.createdByName}
                  {r.reason ? ` — ${r.reason}` : ''}
                </span>
                <a href={pdf(r.revision)} className="underline">
                  {t.detail.downloadRevision(r.revision)}
                </a>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t.detail.events} testId="contract-events">
          <ul className="divide-y divide-stone-100 text-sm">
            {d.events.map((e, i) => (
              <li key={i} className="py-2 wrap-anywhere">
                {formatDateTimeCs(e.at)} · {e.actorName} · {t.events[e.kind]}
                {e.revision ? ` (${t.revisionShort(e.revision)})` : ''}
                {e.reason ? ` — ${e.reason}` : ''}
              </li>
            ))}
          </ul>
        </Card>

        {d.signed.length > 0 ? (
          <Notice tone="info">
            <span data-testid="contract-removal-locked">{t.signed.lockedRemoval}</span>
          </Notice>
        ) : (
          <Card title={d.removed ? t.remove.restore : t.remove.open} testId="contract-removal">
            {/* A new state starts closed (removing opens "restore" as a new step, never pre-opened). */}
            <details key={String(d.removed)}>
              <summary
                className="cursor-pointer text-sm font-medium"
                data-testid="contract-removal-open"
              >
                {d.removed ? t.remove.restore : t.remove.open}
              </summary>
              <div className="mt-3">
                <RemoveOrRestore
                  key={d.version}
                  code={d.code}
                  version={d.version}
                  removed={d.removed}
                />
              </div>
            </details>
          </Card>
        )}
      </div>
    </>
  );
}
