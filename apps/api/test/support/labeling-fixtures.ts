import { randomUUID } from 'node:crypto';
import type { CrateRegistration, LabelingState, StationSessionResult } from '@ayvo/types';
import request from 'supertest';
import { receiveItem } from './warehouse-fixtures.js';
import { TEST_QR_BASE_URL, SUPERUSER_EMAIL, type TestApp } from './test-app.js';

/**
 * Labelling into crates (doc 025 A3) for superuser test apps: a complete catalogue set (crate
 * type, label, liquid, pump, product, ACTIVE recipe with the NEW_BOTTLE item), approved designs, a
 * labelling station with an open session, crates and the scan. Synthetic data only.
 */
const http = (t: TestApp) => request(t.app.getHttpServer());
const sfx = () => randomUUID().slice(0, 6).toUpperCase();

export interface LabelingKit {
  productCode: string;
  crateTypeCode: string;
  labelItemCode: string;
  labelItemId: string;
}

export async function labelingKit(
  t: TestApp,
  opts: { category?: string; capacity?: number; labelStock?: number } = {},
): Promise<LabelingKit> {
  const category = opts.category ?? 'HAND_SOAP';
  const api = '/api/admin/catalog';
  const component = async (body: Record<string, unknown>) =>
    (
      await http(t)
        .post(`${api}/components`)
        .send({
          requestId: randomUUID(),
          reason: 'testovací komponenta',
          packageCapacity: null,
          ...body,
        })
        .expect(201)
    ).body as { code: string };
  const label = await component({
    kind: 'LABEL_MEDIA',
    code: `LBL-${sfx()}`,
    name: 'Etiketa',
    unitCode: 'pcs',
    lotTracked: false,
    categoryCode: category,
  });
  const liquid = await component({
    kind: 'BULK_LIQUID',
    code: `LIQ-${sfx()}`,
    name: 'Kapalina',
    unitCode: 'ml',
    lotTracked: true,
    categoryCode: category,
  });
  const pump = await component({
    kind: 'PUMP',
    code: `PMP-${sfx()}`,
    name: 'Pumpička',
    unitCode: 'pcs',
    lotTracked: false,
    categoryCode: null,
  });
  const crateType = (
    await http(t)
      .post(`${api}/crate-types`)
      .send({
        requestId: randomUUID(),
        code: `CRT-${sfx()}`,
        name: 'Vratná bedna',
        capacity: opts.capacity ?? 40,
        categoryCodes: [category],
        reason: 'typ bedny pro test',
      })
      .expect(201)
  ).body as { code: string };
  const product = (
    await http(t)
      .post(`${api}/products`)
      .send({
        requestId: randomUUID(),
        code: `P-${sfx()}`,
        name: 'Tekuté mýdlo 330 ml',
        categoryCode: category,
        nominalQuantity: '330',
        nominalUnitCode: 'ml',
        reason: 'testovací produkt',
      })
      .expect(201)
  ).body as { code: string };
  await http(t)
    .post(`${api}/products/${product.code}/recipes`)
    .send({
      requestId: randomUUID(),
      reason: 'návrh',
      crateTypeCode: crateType.code,
      components: [
        { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
        { itemCode: label.code, quantity: '1', unitCode: 'pcs' },
        { itemCode: liquid.code, quantity: '330', unitCode: 'ml' },
        { itemCode: pump.code, quantity: '1', unitCode: 'pcs' },
      ],
    })
    .expect(201);
  await http(t)
    .post(`${api}/products/${product.code}/recipes/1/activate`)
    .send({ requestId: randomUUID(), reason: 'schváleno', expectedActiveVersion: null })
    .expect(200);
  const labelItem = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: label.code } });
  if ((opts.labelStock ?? 1000) > 0) await receiveItem(t, labelItem.id, opts.labelStock ?? 1000);
  return {
    productCode: product.code,
    crateTypeCode: crateType.code,
    labelItemCode: label.code,
    labelItemId: labelItem.id,
  };
}

export async function approveDesign(
  t: TestApp,
  productCode: string,
  labelTemplateVersionId: string,
) {
  return http(t)
    .post(`/api/admin/catalog/products/${productCode}/label-approvals`)
    .send({ requestId: randomUUID(), labelTemplateVersionId, reason: 'schválený design' })
    .expect(201);
}

/** A labelling station and an open session of the superuser (any older session released). */
export async function labelingSession(t: TestApp): Promise<string> {
  const user = await t.prisma.user.findUnique({ where: { email: SUPERUSER_EMAIL } });
  if (user) {
    const active = await t.prisma.workstationSession.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
    });
    for (const s of active) {
      await http(t)
        .post(`/api/admin/station-sessions/${s.id}/release`)
        .send({ requestId: randomUUID() })
        .expect(200);
    }
  }
  const station = (
    await http(t)
      .post('/api/admin/workstations')
      .send({
        requestId: randomUUID(),
        code: `LAB-${sfx()}`,
        name: 'Lepicí stůl',
        mode: 'LABELING',
        categoryCode: null,
        reason: 'testovací pracoviště',
      })
      .expect(201)
  ).body as { qrUrl: string };
  const opened = (
    await http(t)
      .post('/api/admin/station-sessions')
      .send({ requestId: randomUUID(), scannedValue: station.qrUrl })
      .expect(201)
  ).body as StationSessionResult;
  return opened.session.id;
}

export async function registerCrate(t: TestApp, crateTypeCode: string): Promise<string> {
  const reg = (
    await http(t)
      .post('/api/admin/crate-registrations')
      .send({ requestId: randomUUID(), crateTypeCode, quantity: 1 })
      .expect(201)
  ).body as CrateRegistration;
  const crate = await t.prisma.crate.findUniqueOrThrow({ where: { code: reg.crateCodes[0] } });
  return `${TEST_QR_BASE_URL}/${crate.qrToken}`;
}

export const setContext = (
  t: TestApp,
  sessionId: string,
  body: { productCode: string; labelTemplateVersionId: string; sourceLotId: string },
) =>
  http(t)
    .post(`/api/admin/station-sessions/${sessionId}/labeling-context`)
    .send({ requestId: randomUUID(), ...body });

export const loadCrate = (t: TestApp, sessionId: string, scannedValue: string) =>
  http(t)
    .post(`/api/admin/station-sessions/${sessionId}/crate`)
    .send({ requestId: randomUUID(), scannedValue });

export const labelScan = (
  t: TestApp,
  sessionId: string,
  scannedValue: string,
  requestId: string = randomUUID(),
) =>
  http(t)
    .post(`/api/admin/station-sessions/${sessionId}/label-scans`)
    .send({ requestId, scannedValue });

// --- the legacy-compatible helper (applyLabel) --------------------------------------------------

interface Ctx {
  kit: LabelingKit;
  sessionId: string;
  approved: Set<string>;
  crates: Map<string, string>;
  current: { versionId: string; lotId: string } | null;
}
const contexts = new WeakMap<TestApp, Promise<Ctx>>();

/** Labels the scanned bottle into a crate of its design (approving the design once). */
export async function labelIntoCrate(
  t: TestApp,
  body: { lotId: string; scannedValue: string; requestId?: string },
) {
  if (!contexts.has(t)) {
    contexts.set(
      t,
      (async () => ({
        kit: await labelingKit(t, { capacity: 1000, labelStock: 5000 }),
        sessionId: await labelingSession(t),
        approved: new Set<string>(),
        crates: new Map<string, string>(),
        current: null,
      }))(),
    );
  }
  const ctx = await contexts.get(t)!;
  const token = body.scannedValue.trim().split('/').pop() ?? '';
  const bottle = await t.prisma.bottle.findUnique({
    where: { publicToken: token },
    include: { creationBatch: true },
  });
  const versionId = bottle?.creationBatch.labelTemplateVersionId;
  if (versionId) {
    if (!ctx.approved.has(versionId)) {
      await approveDesign(t, ctx.kit.productCode, versionId);
      ctx.approved.add(versionId);
    }
    if (ctx.current?.versionId !== versionId || ctx.current.lotId !== body.lotId) {
      const set = await setContext(t, ctx.sessionId, {
        productCode: ctx.kit.productCode,
        labelTemplateVersionId: versionId,
        sourceLotId: body.lotId,
      });
      if (set.status !== 200) return set;
      ctx.current = { versionId, lotId: body.lotId };
      if (!(set.body as LabelingState).crate) {
        let crate = ctx.crates.get(versionId);
        if (!crate) {
          crate = await registerCrate(t, ctx.kit.crateTypeCode);
          ctx.crates.set(versionId, crate);
        }
        const loaded = await loadCrate(t, ctx.sessionId, crate);
        if (loaded.status !== 200) return loaded;
      }
    }
  }
  return labelScan(t, ctx.sessionId, body.scannedValue, body.requestId);
}
