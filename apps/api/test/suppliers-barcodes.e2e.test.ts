import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  BarcodeLookup,
  GoodsReceipt,
  ItemBarcodes,
  SiteDetail,
  Supplier,
  SupplierDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { createSupplier, receiveItem } from './support/warehouse-fixtures.js';
import { payloadHash } from '../src/database/operation-requests.service.js';

const sfx = () => randomBytes(3).toString('hex').toUpperCase();

/** Ledger and balances: barcodes and their lookup must never move stock. */
async function stockFingerprint(t: TestApp) {
  const [row] = await t.prisma.$queryRaw<{ movements: bigint; balances: string | null }[]>`
    SELECT (SELECT count(*) FROM "inventory_movements") AS movements,
           (SELECT md5(string_agg(b::text, ',' ORDER BY b."item_id", b."location_id", b."lot_id"))
              FROM "inventory_balances" b) AS balances`;
  return { movements: Number(row!.movements), balances: row!.balances };
}

async function newItem(t: TestApp, name = 'Pumpička') {
  return t.prisma.inventoryItem.create({
    data: {
      code: `BC-${sfx()}`,
      name: `${name} ${sfx()}`,
      kind: 'PUMP',
      baseUnit: { connect: { code: 'pcs' } },
      lotTracking: 'NONE',
    },
  });
}

describe.skipIf(!hasDatabase)('supplier details and item barcodes (doc 033)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  const detail = async (id: string) =>
    (await http().get(`/api/admin/suppliers/${id}`).expect(200)).body as SupplierDetail;
  const edit = (id: string, body: object) =>
    http()
      .post(`/api/admin/suppliers/${id}/revisions`)
      .send({ requestId: randomUUID(), ...body });
  const assign = (item: string, code: string, requestId = randomUUID()) =>
    http().post(`/api/admin/inventory/items/${item}/barcodes`).send({ requestId, code });
  const lookup = async (code: string) =>
    (await http().get('/api/admin/inventory/barcodes/lookup').query({ code }).expect(200))
      .body as BarcodeLookup;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  const fullDetails = (s: SupplierDetail) => ({
    revision: s.revision,
    name: s.name,
    companyId: s.companyId,
    vatId: s.vatId,
    countryCode: s.address.countryCode,
    addressLine1: s.address.addressLine1,
    addressLine2: s.address.addressLine2,
    postalCode: s.address.postalCode,
    city: s.address.city,
    contactName: s.contact?.name ?? null,
    contactPhone: s.contact?.phone ?? null,
    contactEmail: s.contact?.email ?? null,
    note: s.note ?? null,
  });

  it('an existing supplier without the new details stays valid; nothing is required later', async () => {
    // Created with the three original fields only, like every supplier before doc 033.
    const old = await createSupplier(t);
    const d = await detail(old.id);
    expect(d).toMatchObject({
      revision: 1,
      address: {
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        city: null,
        countryCode: null,
      },
      contact: { name: null, phone: null, email: null },
      note: null,
    });
    expect(d.revisions).toHaveLength(1);
    expect(d.revisions![0]).toMatchObject({ revision: 1, reason: null });
    // Only a note added: no address or contact is demanded.
    const res = await edit(old.id, {
      ...fullDetails(d),
      note: 'objednávky e-mailem',
      reason: 'doplnění poznámky',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as SupplierDetail).note).toBe('objednávky e-mailem');
    expect((res.body as SupplierDetail).address.countryCode).toBeNull();
  });

  it('a foreign supplier needs no Czech IČO or DIČ; details are validated', async () => {
    const res = await http()
      .post('/api/admin/suppliers')
      .send({
        requestId: randomUUID(),
        name: `Pumpen GmbH ${sfx()}`,
        companyId: 'HRB 123456',
        vatId: null,
        countryCode: 'DE',
        addressLine1: 'Musterstraße 1',
        addressLine2: null,
        postalCode: '80331',
        city: 'München',
        contactName: 'Testkontakt',
        contactPhone: '+49 89 000000',
        contactEmail: 'objednavky@example.test',
        note: null,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body as Supplier).toMatchObject({
      companyId: 'HRB 123456',
      vatId: null,
      address: { countryCode: 'DE', city: 'München', postalCode: '80331' },
      contact: { name: 'Testkontakt', phone: '+49 89 000000' },
    });
    const noId = await http()
      .post('/api/admin/suppliers')
      .send({
        requestId: randomUUID(),
        name: `Foreign ${sfx()}`,
        companyId: null,
        vatId: null,
        countryCode: 'AT',
      });
    expect(noId.status).toBe(201);
    for (const bad of [
      { countryCode: 'Germany' },
      { contactEmail: 'ne-email' },
      { contactPhone: 'abc' },
    ]) {
      const r = await http()
        .post('/api/admin/suppliers')
        .send({
          requestId: randomUUID(),
          name: `Bad ${sfx()}`,
          companyId: null,
          vatId: null,
          ...bad,
        });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('a correction needs a reason and the current revision; history, audit; receipts untouched', async () => {
    const supplier = await createSupplier(t, `Obaly ${sfx()}`);
    const item = await newItem(t);
    const receipt = await receiveItem(t, item.id, 5, { supplierId: supplier.id });
    const receiptRow = await t.prisma.goodsReceipt.findFirstOrThrow({
      where: { supplierId: supplier.id },
      include: { lines: true, documents: true },
    });
    const before = await detail(supplier.id);
    const base = fullDetails(before);

    expect((await edit(supplier.id, { ...base, name: 'Nový název' })).status).toBe(400); // no reason
    expect((await edit(supplier.id, { ...base, reason: 'beze změny' })).body.code).toBe(
      'SUPPLIER_UNCHANGED',
    );
    const taken = await createSupplier(t);
    expect(
      (await edit(supplier.id, { ...base, name: taken.name.toUpperCase(), reason: 'překlep' })).body
        .code,
    ).toBe('SUPPLIER_EXISTS');

    const renamed = `Obaly a.s. ${sfx()}`;
    const ok = await edit(supplier.id, {
      ...base,
      name: renamed,
      countryCode: 'CZ',
      city: 'Přerov',
      contactPhone: '+420 600 000 000',
      reason: 'oprava názvu podle faktury',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = ok.body as SupplierDetail;
    expect(after.revision).toBe(2);
    expect(after.revisions!.map((r) => [r.revision, r.name, r.reason])).toEqual([
      [2, renamed, 'oprava názvu podle faktury'],
      [1, before.name, null],
    ]);
    expect(after.revisions![0]!.changedBy).toBeTruthy();

    // Based on revision 1 again: refused, nothing overwritten.
    const stale = await edit(supplier.id, { ...base, note: 'starý formulář', reason: 'souběh' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SUPPLIER_CHANGED');
    expect((await detail(supplier.id)).note).toBeNull();

    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'SUPPLIER_UPDATED', payload: { path: ['supplier'], equals: supplier.id } },
    });
    expect(audit.reason).toBe('oprava názvu podle faktury');
    expect(audit.payload).toMatchObject({
      revision: 2,
      changed: ['name', 'countryCode', 'city', 'contactPhone'],
    });

    // The receipt, its lines and documents are the same rows; it shows the name it was made under.
    const receiptAfter = await t.prisma.goodsReceipt.findFirstOrThrow({
      where: { supplierId: supplier.id },
      include: { lines: true, documents: true },
    });
    expect(receiptAfter).toEqual(receiptRow);
    const shown = (await http().get(`/api/admin/goods-receipts/${receipt.code}`).expect(200))
      .body as GoodsReceipt;
    expect(shown.supplier.name).toBe(renamed);
    expect(shown.supplierNameAtReceipt).toBe(before.name);
    expect(receipt.supplierNameAtReceipt).toBeNull();
  });

  it('two corrections from the same revision: one wins, the other is refused', async () => {
    const supplier = await createSupplier(t);
    const base = fullDetails(await detail(supplier.id));
    const [a, b] = await Promise.all([
      edit(supplier.id, { ...base, city: 'Brno', reason: 'první' }),
      edit(supplier.id, { ...base, city: 'Olomouc', reason: 'druhý' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const d = await detail(supplier.id);
    expect(d.revision).toBe(2);
    expect(d.revisions).toHaveLength(2);
  });

  it('the database keeps suppliers to their recorded revisions and revisions append-only', async () => {
    const supplier = await createSupplier(t);
    await expect(
      t.prisma.supplier.update({ where: { id: supplier.id }, data: { city: 'Tajně' } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.supplier.update({
        where: { id: supplier.id },
        data: { city: 'Tajně', revision: 2 },
      }),
    ).rejects.toThrow();
    expect(await t.prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).toMatchObject(
      {
        city: null,
        revision: 1,
      },
    );
    await expect(
      t.prisma.supplierRevision.updateMany({
        where: { supplierId: supplier.id },
        data: { name: 'x' },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.supplierRevision.deleteMany({ where: { supplierId: supplier.id } }),
    ).rejects.toThrow();
    // A supplier without its first revision is refused at commit.
    await expect(
      t.prisma.supplier.create({ data: { name: `Bez revize ${sfx()}`, requestId: randomUUID() } }),
    ).rejects.toThrow();
    // Archived: never changed again (also not by a correction).
    await http()
      .post(`/api/admin/suppliers/${supplier.id}/archive`)
      .send({ requestId: randomUUID() })
      .expect(200);
    const base = fullDetails(await detail(supplier.id));
    expect(
      (await edit(supplier.id, { ...base, city: 'Zlín', reason: 'po archivaci' })).body.code,
    ).toBe('SUPPLIER_INACTIVE');
  });

  it('barcodes: exact text with leading zeros, alphanumeric, several per item, lookup', async () => {
    const stock = await stockFingerprint(t);
    const item = await newItem(t);
    const zeros = `000${Math.floor(Math.random() * 1e9)}`.padEnd(13, '0');
    const alnum = `SUP-${sfx()}/a.9`;
    expect((await assign(item.code, zeros)).status).toBe(201);
    const res = await assign(item.code, alnum);
    expect(res.status).toBe(201);
    const list = res.body as ItemBarcodes;
    expect(list.barcodes.map((b) => b.code).sort()).toEqual([zeros, alnum].sort());
    expect(await lookup(zeros)).toMatchObject({
      code: zeros,
      item: { code: item.code, unit: { code: 'pcs' } },
      retired: false,
    });
    // Not the same as the number without zeros, and case-sensitive text.
    expect((await lookup(zeros.replace(/^0+/, ''))).item).toBeNull();
    expect((await lookup(alnum.toLowerCase())).item).toBeNull();
    const row = await t.prisma.inventoryItemBarcode.findFirstOrThrow({ where: { code: zeros } });
    expect(row.code).toBe(zeros);
    // Invalid characters (e.g. a scanner typing with a Czech keyboard layout) and links.
    for (const bad of ['ěščřž', 'AB 12', ''])
      expect((await assign(item.code, bad)).status, bad).toBe(400);
    expect(
      (await assign(item.code, 'https://dev.ayvo.co/q/AbCdEfGhIjKlMnOpQrStUv')).body.code,
    ).toBe('BARCODE_LOOKS_LIKE_QR');
    expect(await stockFingerprint(t)).toEqual(stock);
  });

  it('a code active on one item is refused for another (also concurrently); retire, then reuse', async () => {
    const stock = await stockFingerprint(t);
    const [a, b, c] = [await newItem(t, 'A'), await newItem(t, 'B'), await newItem(t, 'C')];
    const code = `X${sfx()}`;
    expect((await assign(a.code, code)).status).toBe(201);
    const taken = await assign(b.code, code);
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({
      code: 'BARCODE_TAKEN',
      details: { item: { code: a.code, name: a.name } },
    });
    expect((await assign(a.code, code)).body.code).toBe('BARCODE_ALREADY_ON_ITEM');
    expect((await lookup(code)).item?.code).toBe(a.code); // never taken over

    const race = `R${sfx()}`;
    const results = await Promise.all([assign(b.code, race), assign(c.code, race)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('BARCODE_TAKEN');
    expect(
      await t.prisma.inventoryItemBarcode.count({ where: { code: race, retiredAt: null } }),
    ).toBe(1);

    const unknown = await lookup(`U${sfx()}`);
    expect(unknown).toMatchObject({ item: null, retired: false });

    const id = (await t.prisma.inventoryItemBarcode.findFirstOrThrow({ where: { code } })).id;
    expect(
      (
        await http()
          .post(`/api/admin/inventory/barcodes/${id}/retire`)
          .send({ requestId: randomUUID(), reason: 'x' })
      ).status,
    ).toBe(400);
    const retired = await http()
      .post(`/api/admin/inventory/barcodes/${id}/retire`)
      .send({ requestId: randomUUID(), reason: 'dodavatel změnil obal' })
      .expect(200);
    expect((retired.body as ItemBarcodes).barcodes.find((x) => x.id === id)).toMatchObject({
      retireReason: 'dodavatel změnil obal',
    });
    expect(await lookup(code)).toMatchObject({ item: null, retired: true });
    expect(
      (
        await http()
          .post(`/api/admin/inventory/barcodes/${id}/retire`)
          .send({ requestId: randomUUID(), reason: 'znovu' })
      ).body.code,
    ).toBe('BARCODE_ALREADY_RETIRED');
    // Now free for another item; the old assignment stays in the history.
    expect((await assign(b.code, code)).status).toBe(201);
    expect((await lookup(code)).item?.code).toBe(b.code);
    const history = (await http().get(`/api/admin/inventory/items/${a.code}/barcodes`).expect(200))
      .body as ItemBarcodes;
    expect(history.barcodes.find((x) => x.code === code)?.retiredAt).toBeTruthy();

    // The database: no delete, no change except the one-way retirement.
    await expect(t.prisma.inventoryItemBarcode.delete({ where: { id } })).rejects.toThrow();
    await expect(
      t.prisma.inventoryItemBarcode.update({ where: { id }, data: { itemId: c.id } }),
    ).rejects.toThrow();
    expect((await t.prisma.inventoryItemBarcode.findUniqueOrThrow({ where: { id } })).itemId).toBe(
      a.id,
    );
    expect(await stockFingerprint(t)).toEqual(stock);
  });

  it('an archived item gets no code; a replay returns the same result', async () => {
    const item = await newItem(t);
    const requestId = randomUUID();
    const code = `P${sfx()}`;
    expect((await assign(item.code, code, requestId)).status).toBe(201);
    expect((await assign(item.code, code, requestId)).status).toBe(201); // idempotent replay
    expect((await assign(item.code, `${code}2`, requestId)).body.code).toBe('IDEMPOTENCY_CONFLICT');
    await t.prisma.inventoryItem.update({
      where: { id: item.id },
      data: { archivedAt: new Date() },
    });
    expect((await assign(item.code, `Q${sfx()}`)).body.code).toBe('ITEM_ARCHIVED');
  });
});

/**
 * Access through REAL sign-in (doc 033 §4): reading suppliers never shows contacts, prices or
 * documents; corrections and barcodes are ADMIN only; existing roles gain nothing.
 */
describe.skipIf(!hasDatabase)('supplier and barcode access (real sign-in)', () => {
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let other: SiteDetail;
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string, query: object = {}) => http().get(path).query(query).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });
  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `sup-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Sklad ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'supplier access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cookie = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await as(cookie).post('/api/auth/active-site', { siteId: siteIds[0] }).expect(200);
    return cookie;
  }

  beforeAll(async () => {
    ra = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(ra, {
      email: `sup-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Supplier Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `SU-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Jiný sklad',
        countryCode: 'SK',
        addressLine1: 'Testovacia 3',
        addressLine2: null,
        postalCode: '811 02',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE'],
        reason: 'second site',
      })
    ).body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${other.id}/warehouses`, {
        requestId: randomUUID(),
        code: `${other.code}-W`,
        name: 'Sklad',
        reason: 'first warehouse',
      })
      .expect(201);
  });
  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
  });

  it('the new permissions are ADMIN only', async () => {
    for (const code of ['procurement:suppliers_edit', 'inventory:barcodes_manage']) {
      const holders = await ra.prisma.rolePermission.findMany({ where: { permissionCode: code } });
      expect(
        holders.map((h) => h.roleCode),
        code,
      ).toEqual(['ADMIN']);
    }
  });

  it('readers see no contacts, documents or prices; supervisors create but do not correct', async () => {
    const created = await as(admin).post('/api/admin/suppliers', {
      requestId: randomUUID(),
      name: `Kontakty ${sfx()}`,
      companyId: '12345678',
      vatId: 'CZ12345678',
      countryCode: 'CZ',
      city: 'Přerov',
      contactName: 'Testovací osoba',
      contactPhone: '+420 600 000 001',
      contactEmail: 'osoba@example.test',
      note: 'interní',
    });
    expect(created.status).toBe(201);
    const id = (created.body as Supplier).id;
    const item = await ra.prisma.inventoryItem.create({
      data: {
        code: `BC-${sfx()}`,
        name: 'Víčko',
        kind: 'PUMP',
        baseUnit: { connect: { code: 'pcs' } },
        lotTracking: 'NONE',
      },
    });

    const operator = await createUser(['WAREHOUSE_OPERATOR']);
    const list = (await as(operator).get('/api/admin/suppliers').expect(200)).body as Supplier[];
    const seen = list.find((s) => s.id === id)!;
    expect(seen.address.city).toBe('Přerov');
    expect(seen).not.toHaveProperty('contact');
    expect(seen).not.toHaveProperty('note');
    const one = (await as(operator).get(`/api/admin/suppliers/${id}`).expect(200))
      .body as SupplierDetail;
    expect(one).not.toHaveProperty('contact');
    expect(one).not.toHaveProperty('revisions');
    expect(JSON.stringify(one)).not.toMatch(
      /osoba@example|600 000 001|interní|unitPrice|documents/,
    );
    expect((await as(operator).get(`/api/admin/suppliers/${id}/documents`)).status).toBe(403);
    const base = {
      revision: 1,
      name: one.name,
      companyId: one.companyId,
      vatId: one.vatId,
      reason: 'zkouška',
    };
    expect(
      (
        await as(operator).post(`/api/admin/suppliers/${id}/revisions`, {
          requestId: randomUUID(),
          ...base,
        })
      ).status,
    ).toBe(403);
    // Reading codes is part of receiving; managing them is not.
    expect(
      (await as(operator).get('/api/admin/inventory/barcodes/lookup', { code: 'ABC' })).status,
    ).toBe(200);
    expect(
      (
        await as(operator).post(`/api/admin/inventory/items/${item.code}/barcodes`, {
          requestId: randomUUID(),
          code: 'ABC',
        })
      ).status,
    ).toBe(403);

    const supervisor = await createUser(['WAREHOUSE_SUPERVISOR']);
    const sv = (await as(supervisor).get(`/api/admin/suppliers/${id}`).expect(200))
      .body as SupplierDetail;
    expect(sv.contact).toEqual({
      name: 'Testovací osoba',
      phone: '+420 600 000 001',
      email: 'osoba@example.test',
    });
    expect(
      (
        await as(supervisor).post(`/api/admin/suppliers/${id}/revisions`, {
          requestId: randomUUID(),
          ...base,
          city: 'Brno',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(supervisor).post(`/api/admin/inventory/items/${item.code}/barcodes`, {
          requestId: randomUUID(),
          code: 'ABC',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(admin).post(`/api/admin/suppliers/${id}/revisions`, {
          requestId: randomUUID(),
          ...base,
          countryCode: 'CZ',
          city: 'Brno',
          contactName: 'Testovací osoba',
          contactPhone: '+420 600 000 001',
          contactEmail: 'osoba@example.test',
          note: 'interní',
          addressLine1: null,
          addressLine2: null,
          postalCode: null,
        })
      ).status,
    ).toBe(200);
  });

  it('receipts stay at their site; a user of another site reads codes but not the receipt', async () => {
    const supplier = (
      await as(admin).post('/api/admin/suppliers', {
        requestId: randomUUID(),
        name: `Místo ${sfx()}`,
        companyId: null,
        vatId: null,
      })
    ).body as Supplier;
    const doc = await http()
      .post('/api/admin/supplier-documents')
      .set('Cookie', admin)
      .field('requestId', randomUUID())
      .field('supplierId', supplier.id)
      .field('kind', 'DELIVERY_NOTE')
      .field('documentNumber', `DL-${sfx()}`)
      .field('issuedOn', '2026-10-11')
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'dl.pdf')
      .expect(201);
    const item = await ra.prisma.inventoryItem.findUniqueOrThrow({ where: { code: 'NEW_BOTTLE' } });
    const receipt = await as(admin).post('/api/admin/goods-receipts', {
      requestId: randomUUID(),
      supplierId: supplier.id,
      supplierReference: 'DL-1',
      receivedAt: new Date().toISOString(),
      note: null,
      documentIds: [doc.body.id],
      lines: [
        {
          itemId: item.id,
          quantity: '1',
          supplierLotCode: null,
          unitPrice: null,
          currency: null,
          vatRate: null,
        },
      ],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const code = (receipt.body as GoodsReceipt).code;
    const elsewhere = await createUser(['WAREHOUSE_SUPERVISOR'], [other.id]);
    expect((await as(elsewhere).get(`/api/admin/goods-receipts/${code}`)).status).toBe(404);
    expect(
      (await as(elsewhere).get('/api/admin/inventory/barcodes/lookup', { code: 'ABC' })).status,
    ).toBe(200);
    // A site the user has no access to is not a way around it.
    expect(
      (await as(elsewhere).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID })).status,
    ).toBe(403);
  });
});

/** Review 033: database holes, replays of older requests and races of names. */
describe.skipIf(!hasDatabase)(
  'supplier revisions: database guards and replays (review 033)',
  () => {
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => {
      await t?.close();
    });

    it('no phantom revision and no supplier unlike its first revision', async () => {
      const supplier = await createSupplier(t);
      // A revision without the supplier reaching it: refused at commit.
      await expect(
        t.prisma.supplierRevision.create({
          data: {
            supplierId: supplier.id,
            revision: 2,
            name: supplier.name,
            reason: 'podvržená historie',
            changedById: (await t.prisma.user.findFirstOrThrow()).id,
            requestId: randomUUID(),
          },
        }),
      ).rejects.toThrow();
      expect(await t.prisma.supplierRevision.count({ where: { supplierId: supplier.id } })).toBe(1);
      // A supplier whose revision 1 says something else, or that starts at another revision.
      for (const data of [
        { revision: 1, city: 'Jinde' },
        { revision: 5, city: null },
      ]) {
        await expect(
          t.prisma.$transaction(async (tx) => {
            const s = await tx.supplier.create({
              data: { name: `Nesoulad ${sfx()}`, requestId: randomUUID(), ...data },
            });
            await tx.supplierRevision.create({
              data: { supplierId: s.id, revision: 1, name: s.name },
            });
          }),
        ).rejects.toThrow();
      }
    });

    it('a create request sent before doc 033 replays to the same supplier', async () => {
      const requestId = randomUUID();
      const body = { requestId, name: `Před 033 ${sfx()}`, companyId: '12345678', vatId: null };
      const first = await http().post('/api/admin/suppliers').send(body).expect(201);
      const row = await t.prisma.operationRequest.findUniqueOrThrow({ where: { requestId } });
      // Exactly the hash the old code stored for its three-field payload.
      expect(row.payloadSha256).toBe(payloadHash('SUPPLIER_CREATE', body));
      const replay = await http().post('/api/admin/suppliers').send(body).expect(201);
      expect(replay.body.id).toBe(first.body.id);
    });

    it('two suppliers created at once under one name: one wins, the other gets SUPPLIER_EXISTS', async () => {
      const name = `Souběh ${sfx()}`;
      const results = await Promise.all(
        [0, 1].map(() =>
          http()
            .post('/api/admin/suppliers')
            .send({ requestId: randomUUID(), name, companyId: null, vatId: null }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('SUPPLIER_EXISTS');
    });
  },
);
