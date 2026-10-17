import { randomUUID } from 'node:crypto';
import type { CreateHotelRequest, HotelDetail, OrderDetail } from '@ayvo/types';
import request from 'supertest';
import { expect } from 'vitest';
import {
  approveDesign,
  chooseLiquidLot,
  fillingSession,
  fillLoadCrate,
  fillScan,
  finishCrate,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './labeling-fixtures.js';
import { INITIAL_SITE_ID } from './sign-in.js';
import type { TestApp } from './test-app.js';
import { printedBottles, receiveBottles, receiveItem } from './warehouse-fixtures.js';

/**
 * Orders and picking (doc 028) for superuser test apps: hotels, orders and crates made through
 * the real labelling and filling API (never inserted by hand), so a "finished" crate is exactly
 * what Hotovo produces. Synthetic data only.
 */
const http = (t: TestApp) => request(t.app.getHttpServer());

export interface MadeCrate {
  crateUrl: string;
  crateCode: string;
  bottleIds: string[];
  bottleUrls: string[];
}

/** Makes crates of one product (capacity small for speed) up to the requested state. */
export async function crateFactory(t: TestApp, opts: { capacity?: number } = {}) {
  const capacity = opts.capacity ?? 2;
  const kit: LabelingKit = await labelingKit(t, { capacity });
  await receiveItem(t, kit.pumpItemId, 500);
  const bottleLot = (await receiveBottles(t, 200)).lines[0]!.lot!.id;
  const receiveLiquid = async () =>
    (await receiveItem(t, kit.liquidItemId, 330 * 100)).lines[0]!.lot!.id;
  const liquidLot = await receiveLiquid();
  let pool: Awaited<ReturnType<typeof printedBottles>> = [];
  let versionId = '';

  async function refill() {
    pool = await printedBottles(t, 20);
    const row = await t.prisma.bottle.findUniqueOrThrow({
      where: { id: pool[0]!.id },
      include: { creationBatch: true },
    });
    versionId = row.creationBatch.labelTemplateVersionId;
    await approveDesign(t, kit.productCode, versionId);
  }

  async function make(
    state: 'READY_TO_FILL' | 'FILLING' | 'FILLED' = 'FILLED',
    lot: string = liquidLot,
  ): Promise<MadeCrate> {
    if (pool.length < capacity) await refill();
    const bottles = pool.splice(0, capacity);
    const ls = await labelingSession(t);
    const ctx = await setContext(t, ls, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: bottleLot,
    });
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    const crateUrl = await registerCrate(t, kit.crateTypeCode);
    expect((await loadCrate(t, ls, crateUrl)).status).toBe(200);
    for (const b of bottles) {
      const r = await labelScan(t, ls, b.url);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    if (state !== 'READY_TO_FILL') {
      const fs = await fillingSession(t, 'HAND_SOAP');
      expect((await fillLoadCrate(t, fs, crateUrl)).status).toBe(200);
      expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);
      for (const b of state === 'FILLING' ? bottles.slice(0, 1) : bottles) {
        const r = await fillScan(t, fs, b.url);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      if (state === 'FILLED') {
        const done = await finishCrate(t, fs);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
      }
    }
    const crate = await t.prisma.crate.findUniqueOrThrow({
      where: { qrToken: crateUrl.split('/').pop()! },
    });
    return {
      crateUrl,
      crateCode: crate.code,
      bottleIds: bottles.map((b) => b.id),
      bottleUrls: bottles.map((b) => b.url),
    };
  }

  /** Fills every bottle of a READY_TO_FILL crate and finishes it (Hotovo). */
  async function fillAndFinish(made: MadeCrate, lot: string = liquidLot) {
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, made.crateUrl)).status).toBe(200);
    expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);
    for (const url of made.bottleUrls) {
      const r = await fillScan(t, fs, url);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const done = await finishCrate(t, fs);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }

  /** refill(): the next crates carry a new, approved label design (a new printed series). */
  return { kit, capacity, make, fillAndFinish, refill, receiveLiquid };
}

export function hotelBody(overrides: Partial<CreateHotelRequest> = {}): CreateHotelRequest {
  return {
    requestId: randomUUID(),
    name: `Hotel ${randomUUID().slice(0, 6)}`,
    addressLine1: 'Náměstí 1',
    addressLine2: null,
    postalCode: '750 02',
    city: 'Přerov',
    countryCode: 'CZ',
    contactName: 'Recepce',
    contactPhone: '+420 581 000 000',
    contactEmail: 'recepce@hotel.test',
    fulfillmentSiteId: INITIAL_SITE_ID,
    ...overrides,
  };
}

export async function createHotel(t: TestApp, overrides: Partial<CreateHotelRequest> = {}) {
  const res = await http(t).post('/api/admin/hotels').send(hotelBody(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as HotelDetail;
}

/** Today in Europe/Prague (the initial site's time zone), YYYY-MM-DD. */
export function pragueToday(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export async function createOrder(
  t: TestApp,
  hotelCode: string,
  lines: { productCode: string; crates: number }[],
  requestedShipDate = pragueToday(),
) {
  const res = await http(t)
    .post('/api/admin/orders')
    .send({ requestId: randomUUID(), hotelCode, requestedShipDate, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as OrderDetail;
}

export const scanCrate = (
  t: TestApp,
  order: string,
  scannedValue: string,
  requestId = randomUUID(),
) => http(t).post(`/api/admin/orders/${order}/crates`).send({ requestId, scannedValue });

export const removeCrate = (
  t: TestApp,
  order: string,
  crate: string,
  reason: string | null = null,
) =>
  http(t)
    .post(`/api/admin/orders/${order}/crates/${crate}/remove`)
    .send({ requestId: randomUUID(), reason });

export const completeOrder = (t: TestApp, order: string, requestId = randomUUID()) =>
  http(t).post(`/api/admin/orders/${order}/complete`).send({ requestId });

export const cancelOrder = (t: TestApp, order: string, reason = 'hotel zrušil objednávku') =>
  http(t).post(`/api/admin/orders/${order}/cancel`).send({ requestId: randomUUID(), reason });
