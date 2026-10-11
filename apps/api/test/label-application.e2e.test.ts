import { randomUUID } from 'node:crypto';
import type { BottleDetail, BottlePhysical, LabelApplicationResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';
import {
  applyLabel,
  createSupplier,
  drift,
  printedBottles,
  receiveBottles,
} from './support/warehouse-fixtures.js';

describe.skipIf(!hasDatabase)('physical label application (warehouse, doc 018)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    // The ledger and the balances never drift apart, whatever a test did.
    expect(await drift(t)).toEqual([]);
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());
  const lotOnHand = async (lotId: string) =>
    (await t.prisma.inventoryBalance.findFirstOrThrow({ where: { lotId } })).onHand.toFixed();

  it('applies a printed label: one new bottle from the selected lot, the full chain recorded', async () => {
    const receipt = await receiveBottles(t, 3);
    const lot = receipt.lines[0]!.lot!;
    expect(lot).toMatchObject({ kind: 'INTERNAL', code: `${receipt.code}/1` });
    const [bottle] = await printedBottles(t, 1);

    const res = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    }).expect(200);
    const result = res.body as LabelApplicationResult;
    expect(result).toMatchObject({
      outcome: 'APPLIED',
      replayed: false,
      bottle: { code: bottle!.code, status: 'LABELED_EMPTY' },
      consumedLot: { id: lot.id, code: lot.code },
      selectedLot: { id: lot.id, onHand: '2' },
    });
    expect(await lotOnHand(lot.id)).toBe('2');

    // receipt line → lot → movement → LABEL_APPLIED event → bottle
    const event = await t.prisma.bottleEvent.findFirstOrThrow({
      where: { bottleId: bottle!.id, type: 'LABEL_APPLIED' },
    });
    const movement = await t.prisma.inventoryMovement.findFirstOrThrow({
      where: { bottleEventId: event.id },
      include: { lot: { include: { originReceiptLine: { include: { receipt: true } } } } },
    });
    expect(movement).toMatchObject({ type: 'LABEL_APPLICATION', lotId: lot.id });
    expect(movement.quantityDelta.toFixed()).toBe('-1');
    expect(movement.lot!.originReceiptLine!.receipt.code).toBe(receipt.code);
    // print job item → label attachment → the same bottle, same URL
    const attachment = await t.prisma.bottleComponentAttachment.findFirstOrThrow({
      where: { installedEventId: event.id },
      include: { printJobItem: true },
    });
    expect(attachment).toMatchObject({
      bottleId: bottle!.id,
      componentType: 'LABEL',
      removedAt: null,
    });
    expect(attachment.labelQrUrl).toBe(bottle!.url);
    expect(attachment.printJobItem!.bottleId).toBe(bottle!.id);

    const detail = (await http().get(`/api/admin/bottles/${bottle!.code}`).expect(200))
      .body as BottleDetail;
    expect(detail.status).toBe('LABELED_EMPTY');
    expect(detail.labelAppliedAt).toBe(result.bottle.labelAppliedAt);
    expect(detail.events.map((e) => e.type)).toEqual(['CREATED', 'LABEL_APPLIED']);
    const physical = (await http().get(`/api/admin/bottles/${bottle!.code}/physical`).expect(200))
      .body as BottlePhysical;
    expect(physical.labelApplication).toMatchObject({
      lot: { id: lot.id, code: lot.code },
      receipt: { code: receipt.code, lineNo: 1 },
      supplier: { id: receipt.supplier.id },
    });
    expect(physical.components).toEqual([
      expect.objectContaining({ type: 'LABEL', labelQrUrl: bottle!.url, removedAt: null }),
    ]);
  });

  it('a duplicate scan is ALREADY_APPLIED and consumes nothing; a retried request replays', async () => {
    const lot = (await receiveBottles(t, 5)).lines[0]!.lot!;
    const [bottle] = await printedBottles(t, 1);
    const requestId = randomUUID();
    await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    }).expect(200);

    const again = (
      await applyLabel(t, {
        lotId: lot.id,
        seriesCode: bottle!.seriesCode,
        scannedValue: bottle!.url,
      }).expect(200)
    ).body as LabelApplicationResult;
    expect(again).toMatchObject({
      outcome: 'ALREADY_APPLIED',
      replayed: false,
      consumedLot: { id: lot.id },
    });
    const replay = (
      await applyLabel(t, {
        requestId,
        lotId: lot.id,
        seriesCode: bottle!.seriesCode,
        scannedValue: bottle!.url,
      }).expect(200)
    ).body as LabelApplicationResult;
    expect(replay).toMatchObject({ outcome: 'APPLIED', replayed: true });
    expect(await lotOnHand(lot.id)).toBe('4');
    expect(
      await t.prisma.inventoryMovement.count({
        where: { lotId: lot.id, type: 'LABEL_APPLICATION' },
      }),
    ).toBe(1);

    // Same request id, different payload: a conflict, never someone else's result.
    const otherLot = (await receiveBottles(t, 1)).lines[0]!.lot!;
    const conflict = await applyLabel(t, {
      requestId,
      lotId: otherLot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    }).expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('accepts only the exact QR URL of this environment (scanner CR/LF and spaces trimmed)', async () => {
    const lot = (await receiveBottles(t, 2)).lines[0]!.lot!;
    const [bottle] = await printedBottles(t, 1);
    const token = bottle!.publicToken;
    const code = async (scannedValue: string) =>
      (await applyLabel(t, { lotId: lot.id, seriesCode: bottle!.seriesCode, scannedValue })).body
        .code as string;

    expect(await code(token)).toBe('NOT_AYVO_QR'); // raw token
    expect(await code(bottle!.code)).toBe('NOT_AYVO_QR'); // bottle code
    expect(await code(`${TEST_QR_BASE_URL.toUpperCase()}/${token}`)).toBe('NOT_AYVO_QR'); // case changed
    expect(await code(`${TEST_QR_BASE_URL}/${token}/`)).toBe('NOT_AYVO_QR'); // path changed
    expect(await code(`https://qr.ayvo.co/${token}`)).toBe('WRONG_ENVIRONMENT'); // production label
    expect(await code(`https://dev.ayvo.co/q/${token}`)).toBe('WRONG_ENVIRONMENT'); // DEV label
    expect(await code(`${TEST_QR_BASE_URL}/AAAAAAAAAAAAAAAAAAAAAA`)).toBe('UNKNOWN_LABEL');
    expect(await lotOnHand(lot.id)).toBe('2'); // rejections change nothing

    const res = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: `  ${bottle!.url}\r\n`,
    }).expect(200);
    expect(res.body.outcome).toBe('APPLIED');
  });

  it('refuses a label that no completed print job printed', async () => {
    const lot = (await receiveBottles(t, 1)).lines[0]!.lot!;
    const version = await createTemplate(t.app);
    const { batch } = await registerBottles(t.app, version.versionId, 1); // job stays PENDING
    const bottle = await t.prisma.bottle.findFirstOrThrow({
      where: { creationBatch: { code: batch.code } },
    });
    const res = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: batch.code,
      scannedValue: `${TEST_QR_BASE_URL}/${bottle.publicToken}`,
    }).expect(422);
    expect(res.body).toEqual({
      statusCode: 422,
      code: 'LABEL_NOT_PRINTED',
      message: 'This label was never printed by a completed print job',
    });
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: bottle.id } })).status).toBe(
      'CREATED',
    );
  });

  it('never switches lots: an exhausted lot stops; the same request succeeds after a correction', async () => {
    const supplier = await createSupplier(t);
    const receipt = await receiveBottles(t, 1, { supplierId: supplier.id });
    const lot = receipt.lines[0]!.lot!;
    const other = (await receiveBottles(t, 10, { supplierId: supplier.id })).lines[0]!.lot!;
    const [first, second] = await printedBottles(t, 2);
    await applyLabel(t, {
      lotId: lot.id,
      seriesCode: first!.seriesCode,
      scannedValue: first!.url,
    }).expect(200);

    const requestId = randomUUID();
    const exhausted = await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: second!.seriesCode,
      scannedValue: second!.url,
    }).expect(409);
    expect(exhausted.body.code).toBe('LOT_EXHAUSTED');
    expect(await lotOnHand(other.id)).toBe('10'); // the other lot is never touched
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe(
      'CREATED',
    );

    // Rejections are not cached: after the receipt is corrected upwards, the same request works.
    await http()
      .post(`/api/admin/goods-receipts/${receipt.code}/corrections`)
      .send({ requestId: randomUUID(), lineNo: 1, quantityDelta: '1', reason: 'counted one more' })
      .expect(200);
    const ok = await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: second!.seriesCode,
      scannedValue: second!.url,
    }).expect(200);
    expect(ok.body).toMatchObject({ outcome: 'APPLIED', consumedLot: { id: lot.id } });
  });

  it('binds the session to one bottle series: a bottle of another series is refused (WRONG_SERIES)', async () => {
    const lot = (await receiveBottles(t, 3)).lines[0]!.lot!;
    const [mine] = await printedBottles(t, 1);
    const [foreign] = await printedBottles(t, 1);
    expect(foreign!.seriesCode).not.toBe(mine!.seriesCode);

    const requestId = randomUUID();
    const wrong = await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: mine!.seriesCode,
      scannedValue: foreign!.url,
    }).expect(422);
    expect(wrong.body).toEqual({
      statusCode: 422,
      code: 'WRONG_SERIES',
      message: 'This bottle does not belong to the series selected for this session',
    });
    // Nothing happened: no consumption, no event, the bottle is still CREATED.
    expect(await lotOnHand(lot.id)).toBe('3');
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: foreign!.id } })).status).toBe(
      'CREATED',
    );
    // A series code that does not exist matches no bottle; a malformed one is a validation error.
    const unknown = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: 'BC-999999',
      scannedValue: mine!.url,
    }).expect(422);
    expect(unknown.body.code).toBe('WRONG_SERIES');
    await applyLabel(t, { lotId: lot.id, seriesCode: 'nonsense', scannedValue: mine!.url }).expect(
      400,
    );

    // Rejections are not stored: the same request id with the right series is applied.
    const ok = await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: foreign!.seriesCode,
      scannedValue: foreign!.url,
    }).expect(200);
    expect(ok.body).toMatchObject({ outcome: 'APPLIED', bottle: { code: foreign!.code } });
    // The series is part of the idempotent payload: the same request id with another series
    // conflicts instead of replaying.
    const conflict = await applyLabel(t, {
      requestId,
      lotId: lot.id,
      seriesCode: mine!.seriesCode,
      scannedValue: foreign!.url,
    }).expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    // An already labelled bottle scanned in a session of another series is WRONG_SERIES too.
    const again = await applyLabel(t, {
      lotId: lot.id,
      seriesCode: mine!.seriesCode,
      scannedValue: foreign!.url,
    }).expect(422);
    expect(again.body.code).toBe('WRONG_SERIES');
    expect(await lotOnHand(lot.id)).toBe('2');
  });

  it('refuses a lot that is not a new-bottle lot', async () => {
    const [bottle] = await printedBottles(t, 1);
    const res = await applyLabel(t, {
      lotId: randomUUID(),
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    }).expect(422);
    expect(res.body.code).toBe('WRONG_LOT');
  });

  it('50 parallel scans on a lot of 10 → exactly 10 applied, 40 LOT_EXHAUSTED, nothing else touched', async () => {
    const lot = (await receiveBottles(t, 10)).lines[0]!.lot!;
    const bystander = (await receiveBottles(t, 7)).lines[0]!.lot!;
    const bottles = await printedBottles(t, 50);
    const responses = await Promise.all(
      bottles.map((b) =>
        applyLabel(t, { lotId: lot.id, seriesCode: b.seriesCode, scannedValue: b.url }),
      ),
    );
    const outcomes = responses.map((r) => (r.status === 200 ? r.body.outcome : r.body.code));
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'LOT_EXHAUSTED')).toHaveLength(40);
    expect(await lotOnHand(lot.id)).toBe('0');
    expect(await lotOnHand(bystander.id)).toBe('7');
    const ids = bottles.map((b) => b.id);
    expect(
      await t.prisma.bottle.count({ where: { id: { in: ids }, status: 'LABELED_EMPTY' } }),
    ).toBe(10);
    expect(
      await t.prisma.bottleEvent.count({ where: { bottleId: { in: ids }, type: 'LABEL_APPLIED' } }),
    ).toBe(10);
    expect(
      await t.prisma.bottleComponentAttachment.count({ where: { bottleId: { in: ids } } }),
    ).toBe(10);
    expect(
      await t.prisma.inventoryMovement.count({
        where: { lotId: lot.id, type: 'LABEL_APPLICATION' },
      }),
    ).toBe(10);
  });

  it('20 parallel scans of one bottle → 1 APPLIED, 19 ALREADY_APPLIED, one movement', async () => {
    const lot = (await receiveBottles(t, 5)).lines[0]!.lot!;
    const [bottle] = await printedBottles(t, 1);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        applyLabel(t, { lotId: lot.id, seriesCode: bottle!.seriesCode, scannedValue: bottle!.url }),
      ),
    );
    const outcomes = responses.map((r) => r.body.outcome as string);
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ALREADY_APPLIED')).toHaveLength(19);
    expect(await lotOnHand(lot.id)).toBe('4');
    expect(await t.prisma.inventoryMovement.count({ where: { lotId: lot.id } })).toBe(2); // receipt + 1
  });

  it('filters the bottle list by status (labels applied or still awaited)', async () => {
    const lot = (await receiveBottles(t, 2)).lines[0]!.lot!;
    const [first, second, third] = await printedBottles(t, 3);
    await applyLabel(t, {
      lotId: lot.id,
      seriesCode: first!.seriesCode,
      scannedValue: first!.url,
    }).expect(200);
    const list = async (status: string) =>
      (
        await http()
          .get('/api/admin/bottles')
          .query({ batch: first!.seriesCode, status })
          .expect(200)
      ).body as { total: number; items: { code: string }[] };
    expect((await list('LABELED_EMPTY')).items.map((b) => b.code)).toEqual([first!.code]);
    expect((await list('CREATED')).items.map((b) => b.code)).toEqual([third!.code, second!.code]);
    await http().get('/api/admin/bottles').query({ status: 'BROKEN' }).expect(400);
  });

  it('lists recent applications with their lots', async () => {
    const lot = (await receiveBottles(t, 1)).lines[0]!.lot!;
    const [bottle] = await printedBottles(t, 1);
    await applyLabel(t, {
      lotId: lot.id,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    }).expect(200);
    const recent = (await http().get('/api/admin/label-applications').expect(200)).body as {
      items: { bottleCode: string; lotCode: string }[];
    };
    expect(recent.items[0]).toMatchObject({ bottleCode: bottle!.code, lotCode: lot.code });
  });
});
