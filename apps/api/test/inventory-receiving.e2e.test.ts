import { randomUUID } from 'node:crypto';
import type {
  GoodsReceipt,
  GoodsReceiptPage,
  InventoryItem,
  InventoryMovementPage,
  StockOverview,
  Supplier,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import {
  applyLabel,
  createSupplier,
  drift,
  newBottleItemId,
  PDF_BYTES,
  printedBottles,
  receiveBottles,
  uploadDocument,
} from './support/warehouse-fixtures.js';

describe.skipIf(!hasDatabase)('inventory foundation and supplier receiving (doc 018)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    expect(await drift(t)).toEqual([]);
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());
  const receiptBody = async (supplierId: string, documentIds: string[], quantity = '10') => ({
    requestId: randomUUID(),
    supplierId,
    supplierReference: 'DL-1',
    receivedAt: new Date().toISOString(),
    note: null,
    documentIds,
    lines: [
      {
        itemId: await newBottleItemId(t),
        quantity,
        supplierLotCode: null,
        unitPrice: null,
        currency: null,
        vatRate: null,
      },
    ],
  });

  it('seeds reference data only: units, MAIN, NEW_BOTTLE (pcs, lot-tracked) — no stock', async () => {
    const items = (await http().get('/api/admin/inventory/items').expect(200))
      .body as InventoryItem[];
    expect(items.find((i) => i.code === 'NEW_BOTTLE')).toMatchObject({
      kind: 'NEW_BOTTLE',
      unit: { code: 'pcs', decimalPlaces: 0 },
      lotTracked: true,
      settings: null,
    });
    const units = await t.prisma.inventoryUnit.findMany({ orderBy: { code: 'asc' } });
    expect(units.map((u) => [u.code, u.decimalPlaces])).toEqual([
      ['g', 3],
      ['ml', 3],
      ['pcs', 0],
      ['roll', 0],
      ['sheet', 0],
    ]);
  });

  it('suppliers: unique names (case-insensitive), idempotent creation', async () => {
    const requestId = randomUUID();
    const body = { requestId, name: 'Lahve CZ s.r.o.', companyId: '12345678', vatId: null };
    const first = (await http().post('/api/admin/suppliers').send(body).expect(201))
      .body as Supplier;
    const replay = (await http().post('/api/admin/suppliers').send(body).expect(201))
      .body as Supplier;
    expect(replay.id).toBe(first.id);
    const clash = await http()
      .post('/api/admin/suppliers')
      .send({ ...body, requestId: randomUUID(), name: 'LAHVE cz S.R.O.' })
      .expect(409);
    expect(clash.body.code).toBe('SUPPLIER_EXISTS');
  });

  it('supplier documents: PDF/JPEG/PNG only, immutable, served only through the API', async () => {
    const supplier = await createSupplier(t);
    const bad = await http()
      .post('/api/admin/supplier-documents')
      .field('requestId', randomUUID())
      .field('supplierId', supplier.id)
      .field('kind', 'INVOICE')
      .field('documentNumber', 'F-1')
      .field('issuedOn', '2026-10-11')
      .attach('file', Buffer.from('<svg/>'), 'x.svg')
      .expect(422);
    expect(bad.body.code).toBe('UNSUPPORTED_DOCUMENT');
    const doc = await uploadDocument(t, supplier.id, 'INVOICE', 'F-2026-001');
    expect(doc).toMatchObject({
      kind: 'INVOICE',
      contentType: 'application/pdf',
      documentNumber: 'F-2026-001',
    });
    expect(JSON.stringify(doc)).not.toMatch(/supplier-documents\/\d{4}/); // no storage path
    const content = await http().get(doc.contentUrl).buffer(true).expect(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(content.body as Buffer, PDF_BYTES)).toBe(0);
    await expect(
      t.prisma.supplierDocument.update({ where: { id: doc.id }, data: { documentNumber: 'X' } }),
    ).rejects.toThrow();
  });

  it('prices, VAT and dates the database would reject are refused as clear validation errors', async () => {
    // Regression (review of PR #3): these reached database checks and surfaced as HTTP 500.
    const supplier = await createSupplier(t);
    const note = await uploadDocument(t, supplier.id);
    const base = await receiptBody(supplier.id, [note.id]);
    const line = (patch: Record<string, unknown>) => ({
      ...base,
      lines: [{ ...base.lines[0], ...patch }],
    });
    await http()
      .post('/api/admin/goods-receipts')
      .send(line({ vatRate: '21' }))
      .expect(400);
    await http()
      .post('/api/admin/goods-receipts')
      .send(line({ unitPrice: '-1', currency: 'CZK' }))
      .expect(400);
    await http()
      .post('/api/admin/goods-receipts')
      .send(line({ unitPrice: '1', currency: 'CZK', vatRate: '150' }))
      .expect(400);
    await http()
      .post('/api/admin/goods-receipts')
      .send(line({ unitPrice: '1', currency: null }))
      .expect(400);
    const early = await http()
      .post('/api/admin/goods-receipts')
      .send({ ...base, receivedAt: '2019-12-31T12:00:00.000Z' })
      .expect(422);
    expect(early.body.code).toBe('INVALID_DATE');
    const ok = await http()
      .post('/api/admin/goods-receipts')
      .send(line({ unitPrice: '12.5', currency: 'CZK', vatRate: '21' }))
      .expect(201);
    expect(ok.body.lines[0]).toMatchObject({ unitPrice: '12.5', currency: 'CZK', vatRate: '21' });
  });

  it('a receipt needs an invoice or delivery note of the same supplier; quantities are exact', async () => {
    const supplier = await createSupplier(t);
    const other = await createSupplier(t);
    const otherDoc = await uploadDocument(t, supplier.id, 'OTHER_APPROVED');
    const foreign = await uploadDocument(t, other.id, 'DELIVERY_NOTE');
    const note = await uploadDocument(t, supplier.id, 'DELIVERY_NOTE');

    const missing = await http()
      .post('/api/admin/goods-receipts')
      .send(await receiptBody(supplier.id, [otherDoc.id]))
      .expect(422);
    expect(missing.body.code).toBe('DOCUMENT_REQUIRED');
    const wrong = await http()
      .post('/api/admin/goods-receipts')
      .send(await receiptBody(supplier.id, [foreign.id]))
      .expect(422);
    expect(wrong.body.code).toBe('INVALID_DOCUMENT');
    const fraction = await http()
      .post('/api/admin/goods-receipts')
      .send(await receiptBody(supplier.id, [note.id], '2.5'))
      .expect(422);
    expect(fraction.body.code).toBe('INVALID_QUANTITY');
    const future = await http()
      .post('/api/admin/goods-receipts')
      .send({
        ...(await receiptBody(supplier.id, [note.id])),
        receivedAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(422);
    expect(future.body.code).toBe('INVALID_DATE');
    expect(await t.prisma.goodsReceipt.count({ where: { supplierId: supplier.id } })).toBe(0);
  });

  it('receipt confirmation is idempotent; reusing the request id for other input is a conflict', async () => {
    const supplier = await createSupplier(t);
    const note = await uploadDocument(t, supplier.id);
    const body = await receiptBody(supplier.id, [note.id], '100');
    const first = (await http().post('/api/admin/goods-receipts').send(body).expect(201))
      .body as GoodsReceipt;
    const replay = (await http().post('/api/admin/goods-receipts').send(body).expect(201))
      .body as GoodsReceipt;
    expect(replay.code).toBe(first.code);
    const lot = first.lines[0]!.lot!;
    expect(await t.prisma.inventoryMovement.count({ where: { lotId: lot.id } })).toBe(1);
    const conflict = await http()
      .post('/api/admin/goods-receipts')
      .send({ ...body, lines: [{ ...body.lines[0], quantity: '101' }] })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('two suppliers may use the same lot code: separate lots, never merged', async () => {
    // Regression (review of PR #3): lot codes were unique per item across all suppliers.
    const one = await createSupplier(t);
    const two = await createSupplier(t);
    const a = await receiveBottles(t, 3, { supplierId: one.id, supplierLotCode: '2026-10' });
    const b = await receiveBottles(t, 4, { supplierId: two.id, supplierLotCode: '2026-10' });
    expect(a.lines[0]!.lot!.id).not.toBe(b.lines[0]!.lot!.id);
    const balance = (lotId: string) =>
      t.prisma.inventoryBalance
        .findFirstOrThrow({ where: { lotId } })
        .then((x) => x.onHand.toFixed());
    expect([await balance(a.lines[0]!.lot!.id), await balance(b.lines[0]!.lot!.id)]).toEqual([
      '3',
      '4',
    ]);
  });

  it('supplier lots are shared across receipts; without a supplier lot each line gets its own internal lot', async () => {
    const supplier = await createSupplier(t);
    const a = await receiveBottles(t, 4, { supplierId: supplier.id, supplierLotCode: 'L-2026-07' });
    const b = await receiveBottles(t, 6, { supplierId: supplier.id, supplierLotCode: 'L-2026-07' });
    expect(a.lines[0]!.lot).toMatchObject({ kind: 'SUPPLIER', code: 'L-2026-07' });
    expect(b.lines[0]!.lot!.id).toBe(a.lines[0]!.lot!.id);
    const c = await receiveBottles(t, 2, { supplierId: supplier.id });
    const d = await receiveBottles(t, 2, { supplierId: supplier.id });
    expect(c.lines[0]!.lot).toMatchObject({ kind: 'INTERNAL', code: `${c.code}/1` });
    expect(d.lines[0]!.lot!.id).not.toBe(c.lines[0]!.lot!.id);

    const stock = (await http().get('/api/admin/inventory/stock').expect(200))
      .body as StockOverview;
    const bottles = stock.items.find((i) => i.item.code === 'NEW_BOTTLE')!;
    expect(bottles.lots.find((l) => l.id === a.lines[0]!.lot!.id)).toMatchObject({
      onHand: '10',
      supplier: { id: supplier.id },
    });
  });

  it('invoice pending: delivery-note receipts are usable stock; the invoice is linked later (append-only)', async () => {
    const supplier = await createSupplier(t);
    const receipt = await receiveBottles(t, 3, { supplierId: supplier.id });
    expect(receipt.invoicePending).toBe(true);
    const pending = (
      await http().get('/api/admin/goods-receipts?invoice=pending&pageSize=100').expect(200)
    ).body as GoodsReceiptPage;
    expect(pending.items.map((r) => r.code)).toContain(receipt.code);

    const invoice = await uploadDocument(t, supplier.id, 'INVOICE', 'FV-77');
    const requestId = randomUUID();
    const linked = (
      await http()
        .post(`/api/admin/goods-receipts/${receipt.code}/documents`)
        .send({ requestId, documentId: invoice.id })
        .expect(200)
    ).body as GoodsReceipt;
    expect(linked.invoicePending).toBe(false);
    expect(linked.documents!.map((d) => d.kind)).toEqual(['DELIVERY_NOTE', 'INVOICE']);
    await http()
      .post(`/api/admin/goods-receipts/${receipt.code}/documents`)
      .send({ requestId, documentId: invoice.id })
      .expect(200);
    const twice = await http()
      .post(`/api/admin/goods-receipts/${receipt.code}/documents`)
      .send({ requestId: randomUUID(), documentId: invoice.id })
      .expect(409);
    expect(twice.body.code).toBe('DOCUMENT_ALREADY_LINKED');
    const after = (
      await http().get('/api/admin/goods-receipts?invoice=pending&pageSize=100').expect(200)
    ).body as GoodsReceiptPage;
    expect(after.items.map((r) => r.code)).not.toContain(receipt.code);
    await expect(
      t.prisma.goodsReceiptDocument.deleteMany({ where: { documentId: invoice.id } }),
    ).rejects.toThrow();
  });

  it('corrections compensate, never rewrite, and never go below zero (line or stock)', async () => {
    const receipt = await receiveBottles(t, 5);
    const lot = receipt.lines[0]!.lot!;
    const correct = (quantityDelta: string, requestId = randomUUID()) =>
      http()
        .post(`/api/admin/goods-receipts/${receipt.code}/corrections`)
        .send({ requestId, lineNo: 1, quantityDelta, reason: 'counted on the pallet' });

    const minusTwo = (await correct('-2').expect(200)).body as GoodsReceipt;
    expect(minusTwo.lines[0]).toMatchObject({ quantity: '5', netQuantity: '3' });
    expect((await correct('-4').expect(422)).body.code).toBe('CORRECTION_BELOW_ZERO');
    expect((await correct('0.5').expect(422)).body.code).toBe('INVALID_QUANTITY');

    // Stock already used cannot be corrected away.
    const [bottle] = await printedBottles(t, 1);
    const labelled = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    });
    expect(labelled.status, JSON.stringify(labelled.body)).toBe(200);
    expect((await correct('-3').expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
    const requestId = randomUUID();
    await correct('-2', requestId).expect(200);
    await correct('-2', requestId).expect(200); // replay, not a second correction
    expect(
      await t.prisma.goodsReceiptCorrection.count({ where: { receiptLine: { lotId: lot.id } } }),
    ).toBe(2);
    expect(
      (
        await t.prisma.inventoryBalance.findFirstOrThrow({ where: { lotId: lot.id } })
      ).onHand.toFixed(),
    ).toBe('0');

    const ledger = (await http().get(`/api/admin/inventory/movements?lotId=${lot.id}`).expect(200))
      .body as InventoryMovementPage;
    expect(ledger.items.map((m) => [m.type, m.quantityDelta, m.balanceAfter])).toEqual([
      ['RECEIPT_CORRECTION', '-2', '0'],
      ['LABEL_APPLICATION', '-1', '2'],
      ['RECEIPT_CORRECTION', '-2', '3'],
      ['RECEIPT', '5', '5'],
    ]);
    expect(ledger.items[0]!.source).toMatchObject({
      receiptCode: receipt.code,
      correctionReason: 'counted on the pallet',
    });
    expect(ledger.items[1]!.source.bottleCode).toBe(bottle!.code);
  });

  it('planning settings are versioned; low stock yields an advisory, multiple-rounded suggestion', async () => {
    const supplier = await createSupplier(t);
    const settings = (body: Record<string, unknown>) =>
      http()
        .post('/api/admin/inventory/items/NEW_BOTTLE/settings')
        .send({
          requestId: randomUUID(),
          preferredSupplierId: supplier.id,
          leadTimeDays: 14,
          ...body,
        });
    expect(
      (
        await settings({
          reorderPoint: '500',
          targetLevel: '100',
          purchaseMultiple: '1000',
        }).expect(422)
      ).body.code,
    ).toBe('INVALID_SETTINGS');
    expect(
      (
        await settings({ reorderPoint: '0.5', targetLevel: '100', purchaseMultiple: null }).expect(
          422,
        )
      ).body.code,
    ).toBe('INVALID_QUANTITY');
    const huge = '1000000000';
    const item = (
      await settings({
        reorderPoint: huge,
        targetLevel: '1000000500',
        purchaseMultiple: '1000',
      }).expect(200)
    ).body as InventoryItem;
    expect(item.settings).toMatchObject({
      reorderPoint: huge,
      preferredSupplier: { id: supplier.id },
      leadTimeDays: 14,
    });
    const stock = (await http().get('/api/admin/inventory/stock').expect(200))
      .body as StockOverview;
    const bottles = stock.items.find((i) => i.item.code === 'NEW_BOTTLE')!;
    expect(bottles.lowStock).toBe(true);
    expect(BigInt(bottles.suggestedQuantity!) % 1000n).toBe(0n);
    expect(BigInt(bottles.suggestedQuantity!) + BigInt(bottles.available)).toBeGreaterThanOrEqual(
      1000000500n,
    );
    expect(bottles.onOrder).toBeNull();
    expect(bottles.reserved).toBe('0');
    // Back to no thresholds, so later tests are not affected.
    await settings({
      reorderPoint: null,
      targetLevel: null,
      purchaseMultiple: null,
      preferredSupplierId: null,
    }).expect(200);
  });

  it('database guards: balances only through the ledger; ledger, receipts and lines immutable', async () => {
    const receipt = await receiveBottles(t, 2);
    const lotId = receipt.lines[0]!.lot!.id;
    // Raw SQL so PostgreSQL's own message (the guard that fired) reaches the assertion.
    const sql = (statement: string) => t.prisma.$executeRawUnsafe(statement);
    await expect(
      sql(`UPDATE inventory_balances SET on_hand = 100 WHERE lot_id = '${lotId}'`),
    ).rejects.toThrow(/inventory balances change only through the stock ledger/);
    await expect(sql(`DELETE FROM inventory_balances WHERE lot_id = '${lotId}'`)).rejects.toThrow(
      /only through the stock ledger/,
    );
    await expect(
      sql(`UPDATE inventory_movements SET quantity_delta = 50 WHERE lot_id = '${lotId}'`),
    ).rejects.toThrow(/UPDATE on inventory_movements is not allowed/);
    expect(
      (await t.prisma.inventoryBalance.findFirstOrThrow({ where: { lotId } })).onHand.toFixed(),
    ).toBe('2');
    await expect(
      t.prisma.inventoryMovement.updateMany({ where: { lotId }, data: { quantityDelta: 50 } }),
    ).rejects.toThrow();
    await expect(t.prisma.inventoryMovement.deleteMany({ where: { lotId } })).rejects.toThrow();
    await expect(
      t.prisma.goodsReceipt.updateMany({ where: { code: receipt.code }, data: { note: 'x' } }),
    ).rejects.toThrow();
    await expect(t.prisma.goodsReceiptLine.deleteMany({ where: { lotId } })).rejects.toThrow();
    await expect(
      t.prisma.inventoryLot.updateMany({ where: { id: lotId }, data: { code: 'X' } }),
    ).rejects.toThrow();
  });

  it('random sequence of receipts, corrections and scans matches an independent model', async () => {
    // Deterministic PRNG (mulberry32) so a failure is reproducible.
    let seed = 0x2a2a2a2a;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const supplier = await createSupplier(t);
    const bottles = await printedBottles(t, 25);
    const model = new Map<string, number>(); // lotId → on hand
    const lines: { code: string; lotId: string; net: number }[] = [];
    const unused = [...bottles];

    for (let step = 0; step < 45; step++) {
      const r = rand();
      if (r < 0.3 || lines.length === 0) {
        const qty = 1 + Math.floor(rand() * 4);
        const lotCode = rand() < 0.5 ? pick(['S-A', 'S-B']) : null;
        const receipt = await receiveBottles(t, qty, {
          supplierId: supplier.id,
          supplierLotCode: lotCode,
        });
        const lotId = receipt.lines[0]!.lot!.id;
        model.set(lotId, (model.get(lotId) ?? 0) + qty);
        lines.push({ code: receipt.code, lotId, net: qty });
      } else if (r < 0.5) {
        const line = pick(lines);
        const delta = pick([-2, -1, 1, 2]);
        const res = await http()
          .post(`/api/admin/goods-receipts/${line.code}/corrections`)
          .send({
            requestId: randomUUID(),
            lineNo: 1,
            quantityDelta: String(delta),
            reason: 'random test',
          });
        const allowed = line.net + delta >= 0 && (model.get(line.lotId) ?? 0) + delta >= 0;
        expect(res.status).toBe(allowed ? 200 : delta < 0 && line.net + delta >= 0 ? 409 : 422);
        if (allowed) {
          line.net += delta;
          model.set(line.lotId, model.get(line.lotId)! + delta);
        }
      } else if (unused.length > 0) {
        const lotId = pick([...model.keys()]);
        const bottle = unused.shift()!;
        const res = await applyLabel(t, {
          lotId,
          seriesCode: bottle.seriesCode,
          scannedValue: bottle.url,
        });
        if ((model.get(lotId) ?? 0) > 0) {
          expect(res.status).toBe(200);
          model.set(lotId, model.get(lotId)! - 1);
        } else {
          expect(res.body.code).toBe('LOT_EXHAUSTED');
          unused.push(bottle);
        }
      }
    }
    for (const [lotId, onHand] of model) {
      const balance = await t.prisma.inventoryBalance.findFirstOrThrow({ where: { lotId } });
      expect([lotId, balance.onHand.toFixed()]).toEqual([lotId, String(onHand)]);
    }
  });
});
