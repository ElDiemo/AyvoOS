import { supplierDetailSchema, type SupplierRevision } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { buttonClass, Card, Field, FieldList, Notice } from '@/components/ui';
import { ArchiveSupplierButton } from '@/components/warehouse/supplier-form';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const s = warehouseCs.suppliers;

const flat = (r: SupplierRevision): Record<string, string | null> => ({
  name: r.name,
  companyId: r.companyId,
  vatId: r.vatId,
  addressLine1: r.address.addressLine1,
  addressLine2: r.address.addressLine2,
  postalCode: r.address.postalCode,
  city: r.address.city,
  countryCode: r.address.countryCode,
  contactName: r.contact.name,
  contactPhone: r.contact.phone,
  contactEmail: r.contact.email,
  note: r.note,
});

/** Detail dodavatele (doc 033): identification, address, contact, note and the version history. */
export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; saved?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { created, saved } = await searchParams;
  const tz = await siteTimeZone();
  const [x, me] = await Promise.all([
    apiGet(`admin/suppliers/${id}`, supplierDetailSchema),
    currentUser(),
  ]);
  const canEdit = hasPermission(me, 'procurement:suppliers_edit') && !x.archivedAt;
  const canArchive = hasPermission(me, 'procurement:suppliers_manage') && !x.archivedAt;
  const value = (v: string | null | undefined) =>
    v ? (
      <span className="wrap-anywhere">{v}</span>
    ) : (
      <span className="text-stone-400">{s.notGiven}</span>
    );
  const revisions = x.revisions ?? [];
  return (
    <>
      <WarehouseHeader
        active="suppliers"
        title={x.name}
        subtitle={x.archivedAt ? s.archived : undefined}
        back={{ href: '/warehouse/suppliers', label: s.back }}
        actions={
          canEdit || canArchive ? (
            <div className="flex flex-wrap gap-2">
              {canEdit && (
                <Link
                  href={`/warehouse/suppliers/${x.id}/edit`}
                  className={buttonClass.primary}
                  data-testid="edit-supplier"
                >
                  {s.edit}
                </Link>
              )}
              {canArchive && <ArchiveSupplierButton id={x.id} />}
            </div>
          ) : undefined
        }
      />
      {(created || saved) && (
        <p
          role="status"
          className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {created ? s.created : s.saved}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title={s.sectionIdentity}>
          <div data-testid="supplier-identity">
            <FieldList>
              <Field label={s.name}>{value(x.name)}</Field>
              <Field label={s.companyId}>{value(x.companyId)}</Field>
              <Field label={s.vatId}>{value(x.vatId)}</Field>
            </FieldList>
          </div>
        </Card>
        <Card title={s.sectionAddress}>
          <div data-testid="supplier-address">
            <FieldList>
              <Field label={s.addressLine1}>{value(x.address.addressLine1)}</Field>
              {x.address.addressLine2 && (
                <Field label={s.addressLine2}>{value(x.address.addressLine2)}</Field>
              )}
              <Field label={s.postalCode}>{value(x.address.postalCode)}</Field>
              <Field label={s.city}>{value(x.address.city)}</Field>
              <Field label={s.country}>{value(x.address.countryCode)}</Field>
            </FieldList>
          </div>
        </Card>
        <Card title={s.sectionContact}>
          <div data-testid="supplier-contact">
            {x.contact ? (
              <FieldList>
                <Field label={s.contactName}>{value(x.contact.name)}</Field>
                <Field label={s.contactPhone}>{value(x.contact.phone)}</Field>
                <Field label={s.contactEmail}>{value(x.contact.email)}</Field>
                <Field label={s.note}>{value(x.note)}</Field>
              </FieldList>
            ) : (
              <Notice tone="info">{s.contactHidden}</Notice>
            )}
          </div>
        </Card>
        {x.revisions && (
          <Card title={s.history}>
            <ol className="flex flex-col gap-4 text-sm" data-testid="supplier-history">
              {revisions.map((r, i) => {
                const older = revisions[i + 1];
                const now = flat(r);
                const then = older ? flat(older) : null;
                const changes = then ? Object.keys(now).filter((k) => now[k] !== then[k]) : [];
                return (
                  <li key={r.revision} className="border-l-2 border-stone-200 pl-3">
                    <p className="font-medium">
                      {s.revision(r.revision)}
                      {i === 0 && (
                        <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-normal">
                          {s.current}
                        </span>
                      )}
                    </p>
                    <p className="text-stone-600">
                      {formatDateTimeCs(r.createdAt, tz)}
                      {r.changedBy ? ` · ${s.by(r.changedBy)}` : ''}
                    </p>
                    {r.revision === 1 ? (
                      <p className="text-stone-600">
                        {r.changedBy ? s.revisionCreated : s.revisionCreatedBefore}
                      </p>
                    ) : (
                      <>
                        <p className="wrap-anywhere">„{r.reason}“</p>
                        <ul className="mt-1 text-stone-700">
                          {changes.map((k) => (
                            <li key={k} className="wrap-anywhere">
                              {s.fields[k]}: {then?.[k] ?? '—'} → {now[k] ?? '—'}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </Card>
        )}
      </div>
    </>
  );
}
