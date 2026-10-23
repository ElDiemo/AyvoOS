import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, ImportOptions, ImportPreview, ProspectPage } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Obchod (doc 034 §8, §13): the search compares phone numbers only for a query written like a
 * phone, and a manual create never slips past an import of the same owner that is being written
 * (or the other way round) — possible duplicates stay warnings, checked against what the other
 * write committed. The interleaving is forced through database locks, not left to chance.
 */
describe.skipIf(!hasDatabase)('Obchod — search by phone and concurrent creates', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b', { id: string; cookie: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  // Digits on purpose: a name with digits must not match a phone through them.
  const tag = randomUUID().slice(0, 6);
  const base = '/api/admin/sales';

  const prospect = (name: string, extra: object = {}) => ({
    requestId: randomUUID(),
    name,
    countryCode: 'CZ',
    city: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    roomsEstimate: null,
    accommodationType: null,
    website: null,
    source: null,
    priority: null,
    note: null,
    ownerId: null,
    contact: null,
    acknowledgeDuplicates: false,
    ...extra,
  });
  const create = (cookie: string, body: object) =>
    http().post(`${base}/prospects`).set('Cookie', cookie).send(body);
  const search = async (cookie: string, q: string) =>
    (
      await http()
        .get(`${base}/prospects?q=${encodeURIComponent(q)}`)
        .set('Cookie', cookie)
        .expect(200)
    ).body as ProspectPage;
  const exportCsv = async (cookie: string, q: string) =>
    (
      await http()
        .get(`${base}/prospects/export?q=${encodeURIComponent(q)}`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
        })
        .expect(200)
    ).body as string;
  const upload = (cookie: string, path: string, csv: string, json: object) =>
    http()
      .post(`${base}${path}`)
      .set('Cookie', cookie)
      .attach('file', Buffer.from(csv, 'utf8'), 'zajemci.csv')
      .field('options', JSON.stringify(json));
  const options = (mapping: ImportOptions['mapping']): ImportOptions => ({
    mapping,
    defaults: { countryCode: null, contactLabel: null },
    overrides: {},
    ownerId: null,
  });
  const named = (name: string) => t.prisma.salesProspect.count({ where: { name } });

  /**
   * Holds the row lock of the prospect code counter: a write that creates a prospect stops at
   * its serial allocation — after its duplicate check — until `release()`.
   */
  async function holdProspectCounter() {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "code_counters" WHERE "name" = 'sales_prospect' FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await isLocked;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }
  /** Statements of this database now waiting for the counter row and for an owner's lock. */
  async function waiters() {
    const [row] = await t.prisma.$queryRaw<{ counter: number; owner: number }[]>`
      SELECT count(*) FILTER (WHERE "query" ILIKE '%code_counters%')::int AS "counter",
             count(*) FILTER (WHERE "wait_event" = 'advisory')::int AS "owner"
      FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
    return row!;
  }
  /** Waits until `ok` holds for the waiting statements (15 s at most). */
  async function until(ok: (w: { counter: number; owner: number }) => boolean) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const w = await waiters();
      if (ok(w)) return w;
      if (Date.now() > deadline) throw new Error(`waiting statements: ${JSON.stringify(w)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** Starts a request now (supertest is lazy) and keeps its answer. */
  const start = (req: request.Test) => req.then((r) => r);

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('hardening-admin'),
      displayName: 'Admin Souběhu',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    for (const key of ['a', 'b'] as const) {
      const email = unique(`hardening-${key}`);
      const created = await http()
        .post('/api/admin/identity/users')
        .set('Cookie', admin)
        .send({
          email,
          displayName: `Obchodník ${key.toUpperCase()} ${tag}`,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'salesperson',
        })
        .expect(201);
      people[key] = {
        id: (created.body as AdminUserDetail).id,
        cookie: await sessionCookie(t, email),
      };
    }
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('a name with digits never matches a phone; a query written like a phone does', async () => {
    const a = people.a.cookie;
    // The hotel's phone contains "2024"; the guesthouse has "2024" in its name.
    await create(
      a,
      prospect(`Hotel Lípa ${tag}`, {
        contact: {
          label: 'Recepce',
          position: null,
          email: null,
          phone: '+420 777 202 400',
          note: null,
          isPrimary: true,
        },
      }),
    ).expect(201);
    await create(a, prospect(`Penzion 2024 ${tag}`)).expect(201);

    const byName = await search(a, 'Penzion 2024');
    expect(byName.items.map((p) => p.name)).toEqual([`Penzion 2024 ${tag}`]);
    // The export with the same filter holds the same prospects.
    const csv = await exportCsv(a, 'Penzion 2024');
    expect(csv.trim().split('\r\n')).toHaveLength(1 + 1);
    expect(csv).toContain(`Penzion 2024 ${tag}`);
    expect(csv).not.toContain(`Hotel Lípa ${tag}`);
    // A name with digits and the tag (letters and digits) is still found by its name.
    expect((await search(a, `2024 ${tag}`)).items.map((p) => p.name)).toEqual([
      `Penzion 2024 ${tag}`,
    ]);

    // Written like a phone — with spaces, the prefix, or only its end: the hotel's phone.
    for (const q of ['+420 777 202 400', '777 202 400', '00420777202400', '202-400']) {
      expect(
        (await search(a, q)).items.map((p) => p.name),
        q,
      ).toEqual([`Hotel Lípa ${tag}`]);
    }
    // Digits alone are a phone query and a name query at once: both are found.
    expect((await search(a, '2024')).items.map((p) => p.name).sort()).toEqual(
      [`Hotel Lípa ${tag}`, `Penzion 2024 ${tag}`].sort(),
    );
    // Another salesperson finds nothing of it, by name or by phone.
    expect((await search(people.b.cookie, '777 202 400')).total).toBe(0);
    expect((await search(people.b.cookie, 'Penzion 2024')).total).toBe(0);
  });

  it('a manual create waits for the same owner’s import being written, then warns', async () => {
    const name = `Hotel Souběžný import ${tag}`;
    const csv = `Název;Země\r\n${name};CZ\r\n`;
    const opts = options(['name', 'countryCode']);
    const prev = (await upload(people.a.cookie, '/imports/preview', csv, opts).expect(200))
      .body as ImportPreview;
    expect(prev.rows[0]!.duplicates).toEqual([]);

    let second: { counter: number; owner: number } | null = null;
    const counter = await holdProspectCounter();
    let imported!: Promise<request.Response>;
    let manual!: Promise<request.Response>;
    try {
      // The import has checked its duplicates (none) and waits for its prospect codes.
      imported = start(
        upload(people.a.cookie, '/imports', csv, {
          ...opts,
          requestId: randomUUID(),
          rows: [{ row: 2, acknowledgeDuplicates: false }],
          fingerprint: prev.fingerprint,
        }),
      );
      await until((w) => w.counter === 1);
      // Meanwhile the salesperson types the same hotel by hand: it must wait for the import.
      manual = start(create(people.a.cookie, prospect(name)));
      // The second write is held too: by the owner's lock (fixed) or, without it, at the
      // counter after a duplicate check that could not see the first write.
      second = await until((w) => w.owner === 1 || w.counter === 2);
    } finally {
      await counter.release();
    }

    expect((await imported).status).toBe(201);
    const refused = await manual;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(await named(name)).toBe(1);
    // The first write held at the counter, the second at the owner's lock (not at the counter).
    expect(second).toEqual({ counter: 1, owner: 1 });
    // A possible duplicate stays a warning: confirmed explicitly, a second record is created.
    await create(people.a.cookie, prospect(name, { acknowledgeDuplicates: true })).expect(201);
    expect(await named(name)).toBe(2);
    // Another salesperson's same hotel: no warning, no wait, nothing revealed.
    const other = await create(people.b.cookie, prospect(name));
    expect(other.status).toBe(201);
    expect(JSON.stringify(other.body)).not.toContain(people.a.id);
  });

  it('an import waits for the same owner’s manual create being written, then warns', async () => {
    const name = `Hotel Souběžné založení ${tag}`;
    const csv = `Název;Země\r\n${name};CZ\r\n`;
    const opts = options(['name', 'countryCode']);
    const prev = (await upload(people.a.cookie, '/imports/preview', csv, opts).expect(200))
      .body as ImportPreview;

    let second: { counter: number; owner: number } | null = null;
    const counter = await holdProspectCounter();
    let manual!: Promise<request.Response>;
    let imported!: Promise<request.Response>;
    try {
      manual = start(create(people.a.cookie, prospect(name)));
      await until((w) => w.counter === 1);
      imported = start(
        upload(people.a.cookie, '/imports', csv, {
          ...opts,
          requestId: randomUUID(),
          rows: [{ row: 2, acknowledgeDuplicates: false }],
          fingerprint: prev.fingerprint,
        }),
      );
      // The second write is held too: by the owner's lock (fixed) or, without it, at the
      // counter after a duplicate check that could not see the first write.
      second = await until((w) => w.owner === 1 || w.counter === 2);
    } finally {
      await counter.release();
    }

    expect((await manual).status).toBe(201);
    const refused = await imported;
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'IMPORT_DUPLICATES_UNCONFIRMED',
      details: { rows: [2] },
    });
    expect(await named(name)).toBe(1);
    // The first write held at the counter, the second at the owner's lock (not at the counter).
    expect(second).toEqual({ counter: 1, owner: 1 });
  });
});
