import { goodsReceiptCodeSchema, goodsReceiptSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { Card, Field, FieldList } from '@/components/ui';
import { AttachDocument, CorrectionForm } from '@/components/warehouse/receipt-actions';
import { WarehouseHeader } from '@/components/warehouse/warehouse-header';
import {
  formatDateCs,
  formatDateTimeCs,
  formatDeltaCs,
  formatQuantityCs,
  unitCs,
} from '@/i18n/cs/format';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const r = warehouseCs.receipts;

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { code } = await params;
  if (!goodsReceiptCodeSchema.safeParse(code).success) notFound();
  const { created } = await searchParams;
  // Prices and documents are omitted by the API without procurement:cost_read / documents_read.
  const [receipt, me] = await Promise.all([
    apiGet(`admin/goods-receipts/${code}`, goodsReceiptSchema),
    currentUser(),
  ]);
  const canCorrect = hasPermission(me, 'inventory:correct');
  const canAttach = hasPermission(me, 'inventory:receive');
  return (
    <>
      <WarehouseHeader
        active="receipts"
        title={receipt.code}
        subtitle={`${receipt.supplier.name} · ${receipt.supplierReference}`}
        back={{ href: '/warehouse/receipts', label: r.title }}
      />
      {created && (
        <p
          role="status"
          className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {r.created(receipt.code)}
        </p>
      )}
      <div className="flex flex-col gap-6">
        <Card>
          <FieldList>
            <Field label={r.supplier}>{receipt.supplier.name}</Field>
            <Field label={r.reference}>{receipt.supplierReference}</Field>
            <Field label={r.receivedAt}>{formatDateTimeCs(receipt.receivedAt)}</Field>
            {receipt.note && <Field label={r.note}>{receipt.note}</Field>}
            <Field label={r.documents}>
              {receipt.invoicePending ? (
                <span
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
                  data-testid="invoice-status"
                >
                  {r.invoicePending}
                </span>
              ) : (
                <span className="text-xs text-stone-600" data-testid="invoice-status">
                  {r.invoiceComplete}
                </span>
              )}
            </Field>
          </FieldList>
        </Card>

        <Card title={r.lines}>
          <ol className="flex flex-col gap-4">
            {receipt.lines.map((line) => (
              <li
                key={line.lineNo}
                className="rounded-md border border-stone-200 p-4"
                data-testid={`line-${line.lineNo}`}
              >
                <FieldList>
                  <Field label={r.item}>
                    {line.item.name}{' '}
                    <span className="font-mono text-xs text-stone-500">{line.item.code}</span>
                  </Field>
                  <Field label={r.quantity}>
                    {formatQuantityCs(line.quantity)} {unitCs(line.item.unitCode)}
                  </Field>
                  <Field label={r.netQuantity}>
                    <span data-testid={`net-${line.lineNo}`}>
                      {formatQuantityCs(line.netQuantity)} {unitCs(line.item.unitCode)}
                    </span>
                  </Field>
                  {line.lot && (
                    <Field label={r.lot}>
                      <span className="font-mono">{line.lot.code}</span> (
                      {warehouseCs.stock.lotKind[line.lot.kind]})
                    </Field>
                  )}
                  {line.unitPrice && (
                    <Field label={r.price}>
                      {line.unitPrice} {line.currency}
                      {line.vatRate ? ` · ${r.vat} ${line.vatRate}` : ''}
                    </Field>
                  )}
                  <Field label={r.corrections}>
                    {line.corrections.length === 0 ? (
                      r.noCorrections
                    ) : (
                      <ul>
                        {line.corrections.map((c) => (
                          <li key={c.id}>
                            {formatDeltaCs(c.quantityDelta)} · {c.reason} ·{' '}
                            {formatDateTimeCs(c.createdAt)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {canCorrect && <CorrectionForm code={receipt.code} lineNo={line.lineNo} />}
                  </Field>
                </FieldList>
              </li>
            ))}
          </ol>
        </Card>

        <Card title={r.documents}>
          {receipt.documents ? (
            <ul className="mb-4 flex flex-col gap-2 text-sm" data-testid="documents">
              {receipt.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 wrap-anywhere">
                  <span className="font-medium">{warehouseCs.documents.kinds[d.kind]}</span>
                  <span>{d.documentNumber}</span>
                  <span className="text-stone-500">{formatDateCs(d.issuedOn)}</span>
                  <a href={d.contentUrl} className="underline">
                    {r.download}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-stone-500" data-testid="documents-restricted">
              {r.documentsRestricted}
            </p>
          )}
          {canAttach && (
            <>
              <h3 className="mb-2 text-sm font-medium">{r.attachDocument}</h3>
              <AttachDocument code={receipt.code} supplierId={receipt.supplier.id} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
