import { randomBytes, randomUUID } from 'node:crypto';
import type {
  GoodsReceipt,
  LabelPrintJob,
  Supplier,
  SupplierDocument,
  SupplierDocumentKind,
} from '@ayvo/types';
import request from 'supertest';
import { createTemplate, registerBottles } from './fixtures.js';
import { labelIntoCrate } from './labeling-fixtures.js';
import { TEST_QR_BASE_URL, type TestApp } from './test-app.js';

/** A minimal valid PDF (magic bytes are what the API checks). */
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export async function createSupplier(
  t: TestApp,
  name = `Supplier ${randomBytes(3).toString('hex')}`,
) {
  const res = await request(t.app.getHttpServer())
    .post('/api/admin/suppliers')
    .send({ requestId: randomUUID(), name, companyId: null, vatId: null })
    .expect(201);
  return res.body as Supplier;
}

export async function uploadDocument(
  t: TestApp,
  supplierId: string,
  kind: SupplierDocumentKind = 'DELIVERY_NOTE',
  number = `DOC-${randomBytes(3).toString('hex')}`,
) {
  const res = await request(t.app.getHttpServer())
    .post('/api/admin/supplier-documents')
    .field('requestId', randomUUID())
    .field('supplierId', supplierId)
    .field('kind', kind)
    .field('documentNumber', number)
    .field('issuedOn', '2026-10-11')
    .attach('file', PDF_BYTES, 'document.pdf')
    .expect(201);
  return res.body as SupplierDocument;
}

export async function newBottleItemId(t: TestApp): Promise<string> {
  const item = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: 'NEW_BOTTLE' } });
  return item.id;
}

/** Receives new bottles with a delivery note; returns the receipt. */
export async function receiveBottles(
  t: TestApp,
  quantity: number | string,
  opts: {
    supplierId?: string;
    supplierLotCode?: string | null;
    documentKind?: SupplierDocumentKind;
  } = {},
): Promise<GoodsReceipt> {
  return receiveItem(t, await newBottleItemId(t), quantity, opts);
}

/** Receives any item with a delivery note; returns the receipt. */
export async function receiveItem(
  t: TestApp,
  itemId: string,
  quantity: number | string,
  opts: {
    supplierId?: string;
    supplierLotCode?: string | null;
    documentKind?: SupplierDocumentKind;
  } = {},
): Promise<GoodsReceipt> {
  const supplierId = opts.supplierId ?? (await createSupplier(t)).id;
  const document = await uploadDocument(t, supplierId, opts.documentKind ?? 'DELIVERY_NOTE');
  const res = await request(t.app.getHttpServer())
    .post('/api/admin/goods-receipts')
    .send({
      requestId: randomUUID(),
      supplierId,
      supplierReference: `DL-${randomBytes(3).toString('hex')}`,
      receivedAt: new Date().toISOString(),
      note: null,
      documentIds: [document.id],
      lines: [
        {
          itemId,
          quantity: String(quantity),
          supplierLotCode: opts.supplierLotCode ?? null,
          unitPrice: null,
          currency: null,
          vatRate: null,
        },
      ],
    })
    .expect(201);
  return res.body as GoodsReceipt;
}

/** n bottle identities with a COMPLETED print job; returns their exact QR URLs. */
export async function printedBottles(t: TestApp, n: number) {
  const version = await createTemplate(t.app);
  const { batch, printJob } = await registerBottles(t.app, version.versionId, n);
  const job = (
    await request(t.app.getHttpServer())
      .post(`/api/admin/label-print-jobs/${printJob!.code}/generate`)
      .expect(200)
  ).body as LabelPrintJob;
  if (job.status !== 'COMPLETED') throw new Error('print job did not complete');
  const bottles = await t.prisma.bottle.findMany({
    where: { creationBatch: { code: batch.code } },
    orderBy: { serial: 'asc' },
    select: { id: true, code: true, publicToken: true },
  });
  return bottles.map((b) => ({
    ...b,
    url: `${TEST_QR_BASE_URL}/${b.publicToken}`,
    seriesCode: batch.code,
  }));
}

/**
 * Applies the label of a printed bottle the way production does since doc 025 A3: at a
 * labelling station of the superuser, into a crate, with the bottle's design approved for a test
 * product (see labeling-fixtures.ts). Returns the HTTP response of the labelling scan (200 for
 * APPLIED / ALREADY_APPLIED, 4xx with a stable code otherwise).
 */
export async function applyLabel(
  t: TestApp,
  body: { lotId: string; seriesCode?: string; scannedValue: string; requestId?: string },
) {
  return labelIntoCrate(t, body);
}

/** Σ ledger = balance for every (item, location, lot); returns the differing rows (expected []). */
export function drift(t: TestApp) {
  return t.prisma.$queryRaw<unknown[]>`SELECT * FROM ayvo_inventory_drift()`;
}
