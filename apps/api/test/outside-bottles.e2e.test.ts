import type { OutsideBottlesPage } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  correctCrate,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { printedBottles, receiveBottles } from './support/warehouse-fixtures.js';

const MINE = 205;

/**
 * Bottles outside a crate beyond one page (PR #25 review A5-R1): 205 labelled bottles leave their
 * crate when its cycle is aborted; paging through the bounded pages reaches every one of them —
 * the 201st and later included — with the crate they left, when and why; the totals are right, a
 * search finds one bottle by code or QR, and reading writes nothing. Synthetic data only.
 */
describe.skipIf(!hasDatabase)('bottles outside a crate — every one reachable', () => {
  let t: TestApp;
  let kit: LabelingKit;
  let bottles: Awaited<ReturnType<typeof printedBottles>>;
  let crateCode: string;
  const http = () => request(t.app.getHttpServer());
  const page = async (query: Record<string, string | number>) =>
    (await http().get('/api/admin/bottles-outside-crates').query(query).expect(200))
      .body as OutsideBottlesPage;

  beforeAll(async () => {
    t = await createTestApp();
    kit = await labelingKit(t, { capacity: 300 });
    bottles = await printedBottles(t, MINE);
    const row = await t.prisma.bottle.findUniqueOrThrow({
      where: { id: bottles[0]!.id },
      include: { creationBatch: true },
    });
    await approveDesign(t, kit.productCode, row.creationBatch.labelTemplateVersionId);
    const session = await labelingSession(t);
    await setContext(t, session, {
      productCode: kit.productCode,
      labelTemplateVersionId: row.creationBatch.labelTemplateVersionId,
      sourceLotId: (await receiveBottles(t, MINE)).lines[0]!.lot!.id,
    }).expect(200);
    const crateUrl = await registerCrate(t, kit.crateTypeCode);
    await loadCrate(t, session, crateUrl).expect(200);
    for (const b of bottles) expect((await labelScan(t, session, b.url)).status).toBe(200);
    crateCode = (
      await t.prisma.crate.findUniqueOrThrow({ where: { qrToken: crateUrl.split('/').pop()! } })
    ).code;
    await correctCrate(t, crateCode, 'abort-cycle', { reason: 'test stránkování' }).expect(200);
  }, 300_000);
  afterAll(async () => {
    await t?.close();
  });

  it('pages through more than 200 bottles: every one reachable, totals right, nothing written', async () => {
    const movements = await t.prisma.inventoryMovement.count();
    const first = await page({ group: 'labelledEmpty', pageSize: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.total).toBeGreaterThanOrEqual(MINE);
    expect(first.totals.labelledEmpty).toBe(first.total);
    const pages = Math.ceil(first.total / 100);
    const seen = new Map<string, OutsideBottlesPage['items'][number]>();
    for (let p = 1; p <= pages; p++) {
      const res = await page({ group: 'labelledEmpty', pageSize: 100, page: p });
      expect(res.items.length).toBeLessThanOrEqual(100);
      for (const item of res.items) {
        expect(seen.has(item.code)).toBe(false); // no duplicates across pages
        seen.set(item.code, item);
      }
    }
    expect(seen.size).toBe(first.total);
    for (const b of bottles) {
      expect(seen.get(b.code), b.code).toMatchObject({
        status: 'LABELED_EMPTY',
        lastCrate: crateCode,
        reason: 'test stránkování',
      });
    }
    // The 201st and the last one directly, by code and by QR.
    const by = async (search: string) =>
      (await page({ group: 'labelledEmpty', search })).items.map((i) => i.code);
    expect(await by(bottles[200]!.code)).toEqual([bottles[200]!.code]);
    expect(await by(bottles[MINE - 1]!.url)).toEqual([bottles[MINE - 1]!.code]);
    // Beyond the last page: empty, never an error or "everything".
    expect((await page({ group: 'labelledEmpty', pageSize: 100, page: pages + 1 })).items).toEqual(
      [],
    );
    // A page is bounded by the contract.
    await http().get('/api/admin/bottles-outside-crates').query({ pageSize: 101 }).expect(400);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
  });
});
