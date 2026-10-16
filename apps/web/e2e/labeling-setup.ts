import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Synthetic set-up for labelling into crates (doc 025 A3) through the real API: catalogue
 * components, a crate type, a product with an ACTIVE recipe using NEW_BOTTLE, label stock, an
 * approved label design and a labelling station. Used by the specs that need labelled bottles.
 */
type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
const sfx = () => crypto.randomUUID().slice(0, 6).toUpperCase();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export interface LabelingSetup {
  productCode: string;
  productName: string;
  crateTypeCode: string;
  stationUrl: string;
  stationCode: string;
}

export async function labelingSetup(
  request: APIRequestContext,
  opts: { versionId: string; capacity?: number; approve?: boolean; productName?: string },
): Promise<LabelingSetup> {
  const api = '/api/admin/catalog';
  const label = await json<{ code: string }>(
    await request.post(`${api}/components`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E etiketa',
        packageCapacity: null,
        kind: 'LABEL_MEDIA',
        code: `E2E-LBL-${sfx()}`,
        name: 'Etiketa (E2E)',
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: 'HAND_SOAP',
      },
    }),
  );
  const liquid = await json<{ code: string }>(
    await request.post(`${api}/components`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E kapalina',
        packageCapacity: null,
        kind: 'BULK_LIQUID',
        code: `E2E-LIQ-${sfx()}`,
        name: 'Kapalina (E2E)',
        unitCode: 'ml',
        lotTracked: true,
        categoryCode: 'HAND_SOAP',
      },
    }),
  );
  const pump = await json<{ code: string }>(
    await request.post(`${api}/components`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E pumpička',
        packageCapacity: null,
        kind: 'PUMP',
        code: `E2E-PMP-${sfx()}`,
        name: 'Pumpička (E2E)',
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: null,
      },
    }),
  );
  const crateType = await json<{ code: string }>(
    await request.post(`${api}/crate-types`, {
      data: {
        requestId: crypto.randomUUID(),
        code: `E2E-CRT-${sfx()}`,
        name: 'Vratná bedna (E2E)',
        capacity: opts.capacity ?? 40,
        categoryCodes: ['HAND_SOAP'],
        reason: 'E2E typ bedny',
      },
    }),
  );
  const productName = opts.productName ?? 'Tekuté mýdlo 330 ml (E2E)';
  const product = await json<{ code: string }>(
    await request.post(`${api}/products`, {
      data: {
        requestId: crypto.randomUUID(),
        code: `E2E-P-${sfx()}`,
        name: productName,
        categoryCode: 'HAND_SOAP',
        nominalQuantity: '330',
        nominalUnitCode: 'ml',
        reason: 'E2E produkt',
      },
    }),
  );
  await json(
    await request.post(`${api}/products/${product.code}/recipes`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E receptura',
        crateTypeCode: crateType.code,
        components: [
          { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: label.code, quantity: '1', unitCode: 'pcs' },
          { itemCode: liquid.code, quantity: '330', unitCode: 'ml' },
          { itemCode: pump.code, quantity: '1', unitCode: 'pcs' },
        ],
      },
    }),
  );
  await json(
    await request.post(`${api}/products/${product.code}/recipes/1/activate`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E schváleno',
        expectedActiveVersion: null,
      },
    }),
  );
  // Label stock (not lot-tracked) so that labelling can consume one label per bottle.
  const items = await json<{ id: string; code: string }[]>(
    await request.get('/api/admin/inventory/items'),
  );
  const supplier = await json<{ id: string }>(
    await request.post('/api/admin/suppliers', {
      data: {
        requestId: crypto.randomUUID(),
        name: `Etikety E2E ${sfx()}`,
        companyId: null,
        vatId: null,
      },
    }),
  );
  const note = await json<{ id: string }>(
    await request.post('/api/admin/supplier-documents', {
      multipart: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        kind: 'DELIVERY_NOTE',
        documentNumber: `DL-${sfx()}`,
        issuedOn: '2026-10-14',
        file: { name: 'dl.pdf', mimeType: 'application/pdf', buffer: PDF },
      },
    }),
  );
  await json(
    await request.post('/api/admin/goods-receipts', {
      data: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        supplierReference: `DL-${sfx()}`,
        receivedAt: new Date().toISOString(),
        note: null,
        documentIds: [note.id],
        lines: [
          {
            itemId: items.find((i) => i.code === label.code)!.id,
            quantity: '100',
            supplierLotCode: null,
            unitPrice: null,
            currency: null,
            vatRate: null,
          },
        ],
      },
    }),
  );
  if (opts.approve ?? true) {
    await json(
      await request.post(`${api}/products/${product.code}/label-approvals`, {
        data: {
          requestId: crypto.randomUUID(),
          labelTemplateVersionId: opts.versionId,
          reason: 'E2E schválený design',
        },
      }),
    );
  }
  const stationCode = `E2E-LAB-${sfx()}`;
  const station = await json<{ qrUrl: string }>(
    await request.post('/api/admin/workstations', {
      data: {
        requestId: crypto.randomUUID(),
        code: stationCode,
        name: 'Lepicí stůl (E2E)',
        mode: 'LABELING',
        categoryCode: null,
        reason: 'E2E pracoviště',
      },
    }),
  );
  return {
    productCode: product.code,
    productName,
    crateTypeCode: crateType.code,
    stationUrl: station.qrUrl,
    stationCode,
  };
}

/** Registers one crate and returns its QR URL. */
export async function crateUrl(request: APIRequestContext, crateTypeCode: string): Promise<string> {
  const reg = await json<{ crateCodes: string[] }>(
    await request.post('/api/admin/crate-registrations', {
      data: { requestId: crypto.randomUUID(), crateTypeCode, quantity: 1 },
    }),
  );
  const detail = await json<{ qrUrl: string }>(
    await request.get(`/api/admin/crates/${reg.crateCodes[0]}`),
  );
  return detail.qrUrl;
}

/** Leaves the user's open station (if any) and opens the given one; returns the session id. */
export async function openStation(request: APIRequestContext, stationUrl: string): Promise<string> {
  const current = await json<{
    current: { session: { id: string } } | null;
    blocked: { sessionId: string } | null;
  }>(await request.get('/api/admin/station-sessions/current'));
  const own = current.current?.session.id ?? current.blocked?.sessionId;
  if (own) {
    await json(
      await request.post(`/api/admin/station-sessions/${own}/release`, {
        data: { requestId: crypto.randomUUID() },
      }),
    );
  }
  const opened = await json<{ session: { id: string } }>(
    await request.post('/api/admin/station-sessions', {
      data: { requestId: crypto.randomUUID(), scannedValue: stationUrl },
    }),
  );
  return opened.session.id;
}

export async function releaseOwnStation(request: APIRequestContext): Promise<void> {
  const current = await json<{
    current: { session: { id: string } } | null;
    blocked: { sessionId: string } | null;
  }>(await request.get('/api/admin/station-sessions/current'));
  const own = current.current?.session.id ?? current.blocked?.sessionId;
  if (own) {
    await json(
      await request.post(`/api/admin/station-sessions/${own}/release`, {
        data: { requestId: crypto.randomUUID() },
      }),
    );
  }
}

export async function lotId(request: APIRequestContext, lotCode: string): Promise<string> {
  const lots = await json<{ id: string; code: string }[]>(
    await request.get('/api/admin/inventory/lots?item=NEW_BOTTLE&available=false'),
  );
  return lots.find((l) => l.code === lotCode)!.id;
}
