import { randomUUID } from 'node:crypto';
import type { CatalogComponent, InventoryMovementPage, StockOverview } from '@ayvo/types';
import request from 'supertest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { receiveItem } from './support/warehouse-fixtures.js';

/**
 * Consumables issued to consumption by hand (owner 2026-10-27, doc 018 §5a) — e.g. a printer
 * ribbon (1 pcs = one roll of 300 m): outside recipes, received like any item, issued with a
 * reason, audited; one request id issues once, a changed stock refuses (no double write-off from
 * two clicks or tabs), the ledger never goes negative; the database holds the same rules.
 */
describe.skipIf(!hasDatabase)('consumables issued to consumption (doc 018 §5a)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  const sfx = () => randomUUID().slice(0, 6).toUpperCase();
  const issue = (body: Record<string, unknown>) =>
    http()
      .post('/api/admin/inventory/issues')
      .send({ requestId: randomUUID(), lotId: null, reason: 'nová role do tiskárny', ...body });
  const onHand = async (code: string) =>
    ((await http().get('/api/admin/inventory/stock').expect(200)).body as StockOverview).items.find(
      (i) => i.item.code === code,
    )!.onHand;
  async function consumable(lotTracked = false) {
    const res = await http()
      .post('/api/admin/catalog/components')
      .send({
        requestId: randomUUID(),
        code: `RIBBON-${sfx()}`,
        name: 'Ribbon zlatý 300 m',
        kind: 'CONSUMABLE',
        unitCode: 'pcs',
        lotTracked,
        categoryCode: null,
        packageCapacity: null,
        reason: 'spotřební materiál tisku',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const c = res.body as CatalogComponent;
    const item = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: c.code } });
    return { code: c.code, id: item.id };
  }

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('issues once per request; a changed stock or too little stock issues nothing; audited with the reason', async () => {
    const ribbon = await consumable();
    await receiveItem(t, ribbon.id, 3);
    expect(await onHand(ribbon.code)).toBe('3');

    const requestId = randomUUID();
    const body = { requestId, itemCode: ribbon.code, quantity: '1', expectedOnHand: '3' };
    const first = await issue(body).expect(201);
    expect(first.body).toMatchObject({ itemCode: ribbon.code, quantity: '1', balanceAfter: '2' });
    // The same request again (a repeated click, a lost answer): the same result, nothing more.
    expect((await issue(body).expect(201)).body).toEqual(first.body);
    expect(await onHand(ribbon.code)).toBe('2');
    expect((await issue({ ...body, quantity: '2' })).body.code).toBe('IDEMPOTENCY_CONFLICT');
    // A new request with the stock seen before (another tab): refused, nothing issued.
    const stale = await issue({ itemCode: ribbon.code, quantity: '1', expectedOnHand: '3' });
    expect([stale.status, stale.body.code, stale.body.details]).toEqual([
      409,
      'STOCK_CHANGED',
      { onHand: '2' },
    ]);
    const tooMuch = await issue({ itemCode: ribbon.code, quantity: '3', expectedOnHand: '2' });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, 'INSUFFICIENT_STOCK']);
    expect(await onHand(ribbon.code)).toBe('2');

    // The ledger and the audit say what happened and why.
    const ledger = (
      await http().get(`/api/admin/inventory/movements?item=${ribbon.code}`).expect(200)
    ).body as InventoryMovementPage;
    expect(ledger.items.map((m) => [m.type, m.quantityDelta, m.balanceAfter])).toEqual([
      ['CONSUMPTION_ISSUE', '-1', '2'],
      ['RECEIPT', '3', '3'],
    ]);
    expect(ledger.items[0]!.source.issueReason).toBe('nová role do tiskárny');
    const audit = (
      await t.prisma.auditEvent.findMany({
        where: { type: 'STOCK_ISSUED' },
        select: { reason: true, siteId: true, payload: true },
      })
    ).filter((e) => (e.payload as { item?: string }).item === ribbon.code);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reason: 'nová role do tiskárny',
      siteId: INITIAL_SITE_ID,
      payload: { item: ribbon.code, quantity: '1', unit: 'pcs', lot: null, balanceAfter: '2' },
    });
  });

  it('two concurrent issues from the same stock: exactly one is issued', async () => {
    const ribbon = await consumable();
    await receiveItem(t, ribbon.id, 2);
    const results = await Promise.all(
      [0, 1].map(() => issue({ itemCode: ribbon.code, quantity: '1', expectedOnHand: '2' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('STOCK_CHANGED');
    expect(await onHand(ribbon.code)).toBe('1');
  });

  it('refuses what is not a consumable issue: recipe materials, wrong lots, fractions, no reason', async () => {
    const ribbon = await consumable();
    await receiveItem(t, ribbon.id, 1);
    const bottle = await t.prisma.inventoryItem.findUniqueOrThrow({
      where: { code: 'NEW_BOTTLE' },
    });
    const cases: [Record<string, unknown>, number, string?][] = [
      [{ itemCode: bottle.code, quantity: '1', expectedOnHand: '0' }, 422, 'NOT_CONSUMABLE'],
      [{ itemCode: ribbon.code, quantity: '0.5', expectedOnHand: '1' }, 422, 'INVALID_QUANTITY'],
      [
        { itemCode: ribbon.code, quantity: '1', expectedOnHand: '1', lotId: randomUUID() },
        422,
        'LOT_NOT_ALLOWED',
      ],
      [{ itemCode: ribbon.code, quantity: '0', expectedOnHand: '1' }, 400],
      [{ itemCode: ribbon.code, quantity: '1', expectedOnHand: '1', reason: ' x ' }, 400],
      [{ itemCode: 'NO-SUCH', quantity: '1', expectedOnHand: '1' }, 404],
    ];
    for (const [body, status, code] of cases) {
      const res = await issue(body);
      expect([JSON.stringify(body), res.status, code ? res.body.code : undefined]).toEqual([
        JSON.stringify(body),
        status,
        code,
      ]);
    }
    expect(await onHand(ribbon.code)).toBe('1');
    // A lot-tracked consumable is issued from the chosen lot only.
    const tracked = await consumable(true);
    const receipt = await receiveItem(t, tracked.id, 2, { supplierLotCode: 'RB-2026-1' });
    const lotId = receipt.lines[0]!.lot!.id;
    expect(
      (await issue({ itemCode: tracked.code, quantity: '1', expectedOnHand: '2' })).body.code,
    ).toBe('LOT_REQUIRED');
    const ok = await issue({ itemCode: tracked.code, quantity: '1', expectedOnHand: '2', lotId });
    expect([ok.status, ok.body.lot?.code]).toEqual([201, 'RB-2026-1']);
  });

  it('a consumable never enters a recipe', async () => {
    const ribbon = await consumable();
    const product = (
      await http()
        .post('/api/admin/catalog/products')
        .send({
          requestId: randomUUID(),
          code: `SOAP-${sfx()}`,
          name: 'Tekuté mýdlo 330 ml',
          categoryCode: 'HAND_SOAP',
          nominalQuantity: '330',
          nominalUnitCode: 'ml',
          reason: 'nový produkt',
        })
        .expect(201)
    ).body as { code: string };
    const res = await http()
      .post(`/api/admin/catalog/products/${product.code}/recipes`)
      .send({
        requestId: randomUUID(),
        reason: 'návrh',
        crateTypeCode: null,
        components: [{ itemCode: ribbon.code, quantity: '1', unitCode: 'pcs' }],
      });
    expect([res.status, res.body.code]).toEqual([422, 'COMPONENT_NOT_ALLOWED']);
  });

  describe('database rules', () => {
    const rejects = async (p: Promise<unknown>, message: RegExp) => {
      await expect(p).rejects.toThrow(message);
    };
    it('only consumables; append-only; exactly one matching movement; never negative', async () => {
      const ribbon = await consumable();
      await receiveItem(t, ribbon.id, 1);
      const item = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id: ribbon.id } });
      const location = await t.prisma.inventoryLocation.findFirstOrThrow({
        where: { code: 'MAIN' },
      });
      const actor = await t.prisma.user.findFirstOrThrow();
      const row = (
        over: Partial<Prisma.StockIssueUncheckedCreateInput> = {},
      ): Prisma.StockIssueUncheckedCreateInput => ({
        itemId: item.id,
        unitId: item.baseUnitId,
        locationId: location.id,
        quantity: 1,
        reason: 'test pravidel',
        actorId: actor.id,
        occurredAt: new Date(),
        requestId: randomUUID(),
        ...over,
      });
      // Not a consumable.
      const bottle = await t.prisma.inventoryItem.findUniqueOrThrow({
        where: { code: 'NEW_BOTTLE' },
      });
      await rejects(
        t.prisma.stockIssue.create({
          data: row({ itemId: bottle.id, unitId: bottle.baseUnitId, lotId: randomUUID() }),
        }),
        /only a consumable|foreign key/,
      );
      // An issue without its movement does not commit.
      await rejects(
        t.prisma.$transaction(async (tx) => {
          await tx.stockIssue.create({ data: row() });
        }),
        /posted to the ledger in the same transaction/,
      );
      // A movement that does not match its issue.
      await rejects(
        t.prisma.$transaction(async (tx) => {
          const s = await tx.stockIssue.create({ data: row() });
          await tx.inventoryMovement.create({
            data: {
              itemId: item.id,
              unitId: item.baseUnitId,
              locationId: location.id,
              quantityDelta: -2,
              type: 'CONSUMPTION_ISSUE',
              stockIssueId: s.id,
              occurredAt: new Date(),
            },
          });
        }),
        /must match its stock issue/,
      );
      // More than on hand: the ledger's balance check refuses it.
      await rejects(
        t.prisma.$transaction(async (tx) => {
          const s = await tx.stockIssue.create({ data: row({ quantity: 2 }) });
          await tx.inventoryMovement.create({
            data: {
              itemId: item.id,
              unitId: item.baseUnitId,
              locationId: location.id,
              quantityDelta: -2,
              type: 'CONSUMPTION_ISSUE',
              stockIssueId: s.id,
              occurredAt: new Date(),
            },
          });
        }),
        /on_hand|check constraint|violates/,
      );
      // Issued once through the API; the row is never changed or deleted.
      await issue({ itemCode: ribbon.code, quantity: '1', expectedOnHand: '1' }).expect(201);
      const saved = await t.prisma.stockIssue.findFirstOrThrow({ where: { itemId: item.id } });
      // Raw SQL keeps the database's own message (Prisma maps restrict_violation to a FK error).
      await rejects(
        t.prisma.$executeRaw`UPDATE stock_issues SET reason = 'jinak' WHERE id = ${saved.id}::uuid`,
        /immutable record/,
      );
      await rejects(
        t.prisma.$executeRaw`DELETE FROM stock_issues WHERE id = ${saved.id}::uuid`,
        /immutable record/,
      );
    });
  });
});

describe.skipIf(!hasDatabase)('consumption issue permission (real sign-in)', () => {
  let ra: TestApp;
  beforeAll(async () => {
    ra = await createTestApp({}, {}, { auth: 'real' });
  });
  afterAll(async () => {
    await ra?.close();
  });

  it('only ADMIN holds inventory:consume; a warehouse supervisor is refused', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: { permissionCode: 'inventory:consume' },
      select: { roleCode: true },
    });
    expect(holders.map((h) => h.roleCode)).toEqual(['ADMIN']);
    const user = await prepareInvitedUser(ra, {
      email: `issue-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Vedoucí skladu',
    });
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'WAREHOUSE_SUPERVISOR', grantReason: 'test' },
    });
    const cookie = await sessionCookie(ra, user.email);
    const res = await request(ra.app.getHttpServer())
      .post('/api/admin/inventory/issues')
      .set('Cookie', cookie)
      .send({
        requestId: randomUUID(),
        itemCode: 'NEW_BOTTLE',
        lotId: null,
        quantity: '1',
        expectedOnHand: '0',
        reason: 'not allowed',
      });
    expect(res.status).toBe(403);
  });
});
