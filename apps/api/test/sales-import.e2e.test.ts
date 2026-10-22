import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  ImportInspection,
  ImportOptions,
  ImportPreview,
  ImportResult,
  ImportSummary,
  ProspectDetail,
  ProspectPage,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Obchod — CSV import and export of prospects (doc 034 §13) through the real sign-in of
 * SALES-only salespeople and ADMIN: a preview writes nothing; a confirmation creates exactly the
 * selected rows in one transaction, once per request id, with ownership, the target owner and
 * duplicates checked again; the export holds only what the user may see and never runs as a
 * formula in a spreadsheet. Synthetic data only.
 */
describe.skipIf(!hasDatabase)('Obchod — CSV import and export', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b' | 'c', { id: string; cookie: string; name: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const tag = randomUUID().slice(0, 6);
  const base = '/api/admin/sales';

  const upload = (cookie: string, path: string, csv: string | Buffer, json?: object) => {
    const req = http()
      .post(`${base}${path}`)
      .set('Cookie', cookie)
      .attach('file', typeof csv === 'string' ? Buffer.from(csv, 'utf8') : csv, 'zajemci.csv');
    return json ? req.field('options', JSON.stringify(json)) : req;
  };
  const options = (mapping: ImportOptions['mapping'], extra: Partial<ImportOptions> = {}) => ({
    mapping,
    defaults: { countryCode: null, contactLabel: null },
    overrides: {},
    ownerId: null,
    ...extra,
  });
  const counts = async () => ({
    prospects: await t.prisma.salesProspect.count(),
    contacts: await t.prisma.salesContact.count(),
    activities: await t.prisma.salesActivity.count(),
    tasks: await t.prisma.salesTask.count(),
    imports: await t.prisma.salesImport.count(),
    hotels: await t.prisma.hotel.count(),
  });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('import-admin'),
      displayName: 'Admin Importu',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    for (const [key, name] of [
      ['a', 'Importující Adam'],
      ['b', 'Importující Bára'],
      ['c', 'Importující Cyril'],
    ] as const) {
      const email = unique(`import-${key}`);
      const created = await http()
        .post('/api/admin/identity/users')
        .set('Cookie', admin)
        .send({
          email,
          displayName: name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'salesperson',
        })
        .expect(201);
      people[key] = {
        id: (created.body as AdminUserDetail).id,
        cookie: await sessionCookie(t, email),
        name,
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

  /** A table like the ones kept today: semicolons, accents, quotes, a multi-line note. */
  const table = () =>
    '\uFEFFNázev hotelu;Země;Město;Kontaktní osoba;Pozice;E-mail;Telefon;Pokoje;Typ;Priorita;Poznámka;Stav;Datum prvního oslovení;Výsledek;Follow-up odeslán;Interní sloupec\r\n' +
    `"Hotel ""Zlatá Lípa"" ${tag}";CZ;Telč;Ing. Jana Nováková;Ředitelka;jana-${tag}@lipa.test;+420 777 100 200;42;Hotel;A;"Má zájem o vzorky.\r\nVolat dopoledne.";Osloveno;3. 5. 2026;Zájem;ano;x\r\n` +
    `Penzion Žluťoučký kůň ${tag};SK;Bratislava;;;recepce-${tag}@kun.test;00421 2 123 456;;penzion;b;;;;;;\r\n` +
    `Hostel Bez Země ${tag};;Brno;Recepce;;;;12;Hostel;;;;;;;\r\n` +
    `;CZ;Praha;;;;;;;;;;;;;\r\n` +
    `Hotel Chybný ${tag};Narnie;Kdesi;Petr;;neni-email;4,20777E+11;cca 40;zámek;Z;;;;;;\r\n` +
    `"Hotel ""Zlatá Lípa"" ${tag}";CZ;Telč;Recepce;;;;;;;;;;;;\r\n`;
  const mapping: ImportOptions['mapping'] = [
    'name',
    'countryCode',
    'city',
    'contactLabel',
    'contactPosition',
    'contactEmail',
    'contactPhone',
    'roomsEstimate',
    'accommodationType',
    'priority',
    'note',
    'original',
    'original',
    'original',
    'original',
    'ignore',
  ];

  it('inspects and previews a real-looking table without writing anything', async () => {
    const before = await counts();
    const insp = (await upload(people.a.cookie, '/imports/inspect', table()).expect(200))
      .body as ImportInspection;
    expect(insp).toMatchObject({ encoding: 'UTF-8', delimiter: ';', rowCount: 6 });
    expect(insp.headers[0]).toBe('Název hotelu');
    // The proposal maps known headers; old status columns only as original values.
    expect(insp.suggested).toEqual(mapping);

    const prev = (
      await upload(
        people.a.cookie,
        '/imports/preview',
        table(),
        options(mapping, { defaults: { countryCode: null, contactLabel: 'Recepce' } }),
      ).expect(200)
    ).body as ImportPreview;
    expect(prev.owner).toEqual({ id: people.a.id, name: people.a.name });
    const row = (n: number) => prev.rows.find((r) => r.row === n)!;
    expect(prev.counts).toEqual({ total: 6, valid: 3, withErrors: 3, withDuplicates: 2 });
    // Row 2: accents, quotes, a multi-line note and the old columns as labelled original values.
    expect(row(2)).toMatchObject({
      name: `Hotel "Zlatá Lípa" ${tag}`,
      countryCode: 'CZ',
      roomsEstimate: 42,
      priority: 'A',
      contact: { label: 'Ing. Jana Nováková', phone: '+420 777 100 200' },
      errors: [],
      fileDuplicates: [7],
    });
    expect(row(2).note).toBe(
      'Má zájem o vzorky.\r\nVolat dopoledne.\n\nPůvodní údaje z importu (význam nepotvrzen):\n' +
        'Stav: Osloveno\nDatum prvního oslovení: 3. 5. 2026\nVýsledek: Zájem\nFollow-up odeslán: ano',
    );
    // Row 3: the phone keeps its leading zeros; the contact gets the explicit default label.
    expect(row(3)).toMatchObject({
      countryCode: 'SK',
      priority: 'B',
      contact: { label: 'Recepce', phone: '00421 2 123 456' },
      errors: [],
    });
    // Row 4: no country and no default — never guessed from the city or anything else.
    expect(row(4).errors.map((e) => e.code)).toEqual(['COUNTRY_MISSING']);
    expect(row(5).errors.map((e) => e.code)).toEqual(['NAME_MISSING']);
    expect(
      row(6)
        .errors.map((e) => e.code)
        .sort(),
    ).toEqual(
      [
        'COUNTRY_INVALID',
        'EMAIL_INVALID',
        'PHONE_INVALID',
        'PRIORITY_INVALID',
        'ROOMS_INVALID',
        'TYPE_INVALID',
      ].sort(),
    );
    expect(row(6).errors.find((e) => e.code === 'PHONE_INVALID')!.value).toBe('4,20777E+11');
    expect(row(7).fileDuplicates).toEqual([2]);

    // An explicit default country and a per-row fix: only for the rows that need them.
    const fixed = (
      await upload(
        people.a.cookie,
        '/imports/preview',
        table(),
        options(mapping, {
          defaults: { countryCode: 'CZ', contactLabel: 'Recepce' },
          overrides: { '5': { name: `Doplněný hotel ${tag}` } },
        }),
      ).expect(200)
    ).body as ImportPreview;
    expect(fixed.rows.find((r) => r.row === 3)!.countryCode).toBe('SK');
    expect(fixed.rows.find((r) => r.row === 4)!).toMatchObject({ countryCode: 'CZ', errors: [] });
    expect(fixed.rows.find((r) => r.row === 5)!).toMatchObject({
      name: `Doplněný hotel ${tag}`,
      errors: [],
    });
    // Invalid country stays an error (the default is for empty cells only).
    expect(fixed.rows.find((r) => r.row === 6)!.errors.map((e) => e.code)).toContain(
      'COUNTRY_INVALID',
    );
    // Without a default label a contact without a name is an error, never an invented person.
    const noLabel = (
      await upload(people.a.cookie, '/imports/preview', table(), options(mapping)).expect(200)
    ).body as ImportPreview;
    expect(noLabel.rows.find((r) => r.row === 3)!.errors.map((e) => e.code)).toEqual([
      'CONTACT_LABEL_MISSING',
    ]);
    expect(await counts()).toEqual(before);
  });

  it('confirms only the selected rows, once, in one transaction; the result can be found again', async () => {
    const before = await counts();
    const opts = options(mapping, { defaults: { countryCode: 'CZ', contactLabel: 'Recepce' } });
    // A row with errors cannot be selected.
    const bad = await upload(people.a.cookie, '/imports', table(), {
      ...opts,
      requestId: randomUUID(),
      rows: [
        { row: 2, acknowledgeDuplicates: true },
        { row: 6, acknowledgeDuplicates: false },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'IMPORT_ROWS_INVALID', details: { rows: [6] } });
    // A possible duplicate must be confirmed explicitly as a new record.
    const dup = await upload(people.a.cookie, '/imports', table(), {
      ...opts,
      requestId: randomUUID(),
      rows: [{ row: 2, acknowledgeDuplicates: false }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      code: 'IMPORT_DUPLICATES_UNCONFIRMED',
      details: { rows: [2] },
    });
    expect(await counts()).toEqual(before);

    // Rows 2, 3 and 4 (7 is the same hotel as 2 — left out); a double click / lost answer: once.
    const body = {
      ...opts,
      requestId: randomUUID(),
      rows: [
        { row: 2, acknowledgeDuplicates: true },
        { row: 3, acknowledgeDuplicates: false },
        { row: 4, acknowledgeDuplicates: false },
      ],
    };
    const [r1, r2] = await Promise.all([
      upload(people.a.cookie, '/imports', table(), body),
      upload(people.a.cookie, '/imports', table(), body),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const result = r1.body as ImportResult;
    expect(r2.body.code).toBe(result.code);
    expect(result).toMatchObject({
      owner: { id: people.a.id },
      rowCount: 6,
      createdCount: 3,
      createdNotVisible: 0,
    });
    expect(result.created.map((c) => c.row)).toEqual([2, 3, 4]);
    expect(result.skipped).toEqual([
      { row: 5, errors: ['NAME_MISSING'] },
      { row: 6, errors: expect.arrayContaining(['COUNTRY_INVALID', 'PHONE_INVALID']) },
      { row: 7, errors: [] },
    ]);
    // The same request id with another selection is a conflict, never a second import.
    const conflict = await upload(people.a.cookie, '/imports', table(), {
      ...body,
      rows: [{ row: 3, acknowledgeDuplicates: false }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const after = await counts();
    expect(after).toEqual({
      ...before,
      prospects: before.prospects + 3,
      contacts: before.contacts + 3,
      imports: before.imports + 1,
    });
    // New prospects in stage Nový: no invented calls, e-mails or done tasks from old columns.
    const a = (path: string) => http().get(`${base}${path}`).set('Cookie', people.a.cookie);
    const first = (await a(`/prospects/${result.created[0]!.code}`).expect(200))
      .body as ProspectDetail;
    expect(first).toMatchObject({
      stage: 'NEW',
      activities: [],
      openTasks: [],
      closedTasks: [],
      lastContactAt: null,
      roomsEstimate: 42,
      accommodationType: 'HOTEL',
      priority: 'A',
    });
    expect(first.note).toContain('Stav: Osloveno');
    expect(first.contacts).toEqual([
      expect.objectContaining({
        label: 'Ing. Jana Nováková',
        position: 'Ředitelka',
        phone: '+420 777 100 200',
        isPrimary: true,
      }),
    ]);
    expect(first.events.map((e) => e.type).sort()).toEqual(['CONTACT_ADDED', 'PROSPECT_CREATED']);
    expect(first.events.find((e) => e.type === 'PROSPECT_CREATED')!.payload).toMatchObject({
      importCode: result.code,
      importRow: 2,
    });

    // Found again after a reload — by its importer; not by another salesperson.
    const again = (await a(`/imports/${result.code}`).expect(200)).body as ImportResult;
    expect(again).toEqual(result);
    const list = (await a('/imports').expect(200)).body as ImportSummary[];
    expect(list[0]!.code).toBe(result.code);
    const b = (path: string) => http().get(`${base}${path}`).set('Cookie', people.b.cookie);
    expect((await b(`/imports/${result.code}`)).status).toBe(404);
    expect(
      ((await b('/imports').expect(200)).body as ImportSummary[]).map((x) => x.code),
    ).not.toContain(result.code);
    await http().get(`${base}/imports/${result.code}`).set('Cookie', admin).expect(200);
    // History of the import cannot be rewritten.
    await expect(
      t.prisma.salesImport.update({ where: { code: result.code }, data: { fileName: 'x' } }),
    ).rejects.toThrow();
  });

  it('checks owner, permissions and duplicates again on confirmation', async () => {
    const csv = `Název;Země\r\nHotel Pozdní ${tag};CZ\r\n`;
    const opts = options(['name', 'countryCode']);
    // A salesperson imports only for themselves.
    const forB = await upload(people.a.cookie, '/imports/preview', csv, {
      ...opts,
      ownerId: people.b.id,
    });
    expect(forB.status).toBe(403);
    // Duplicates: A's own prospects only — B's same hotel is not even hinted to A.
    await upload(people.b.cookie, '/imports', csv, {
      ...opts,
      requestId: randomUUID(),
      rows: [{ row: 2, acknowledgeDuplicates: false }],
    }).expect(201);
    const prevA = (await upload(people.a.cookie, '/imports/preview', csv, opts).expect(200))
      .body as ImportPreview;
    expect(prevA.rows[0]!.duplicates).toEqual([]);
    // ADMIN sees B's prospect as a duplicate.
    const prevAdmin = (
      await upload(admin, '/imports/preview', csv, { ...opts, ownerId: people.c.id }).expect(200)
    ).body as ImportPreview;
    expect(prevAdmin.owner.id).toBe(people.c.id);
    expect(prevAdmin.rows[0]!.duplicates.map((d) => d.owner)).toEqual([people.b.name]);

    // A duplicate appearing between the preview and the confirmation is caught.
    const csv2 = `Název;Země\r\nHotel Souběžný ${tag};CZ\r\n`;
    const prev2 = (await upload(people.a.cookie, '/imports/preview', csv2, opts).expect(200))
      .body as ImportPreview;
    expect(prev2.rows[0]!.duplicates).toEqual([]);
    await http()
      .post(`${base}/prospects`)
      .set('Cookie', people.a.cookie)
      .send({
        requestId: randomUUID(),
        name: `Hotel Souběžný ${tag}`,
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
      })
      .expect(201);
    const late = await upload(people.a.cookie, '/imports', csv2, {
      ...opts,
      requestId: randomUUID(),
      rows: [{ row: 2, acknowledgeDuplicates: false }],
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('IMPORT_DUPLICATES_UNCONFIRMED');

    // The target owner loses Obchod between the preview and the confirmation.
    const before = await counts();
    await http()
      .post(`/api/admin/identity/users/${people.c.id}/roles/revoke`)
      .set('Cookie', admin)
      .send({ role: 'SALES', reason: 'odchod' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    const gone = await upload(admin, '/imports', csv, {
      ...opts,
      ownerId: people.c.id,
      requestId: randomUUID(),
      rows: [{ row: 2, acknowledgeDuplicates: true }],
    });
    expect(gone.status).toBe(422);
    expect(gone.body.code).toBe('NOT_A_SALESPERSON');
    // The importer loses Obchod: refused on the next request.
    const cSelf = await upload(people.c.cookie, '/imports/preview', csv, opts);
    expect([401, 403]).toContain(cSelf.status);
    expect(await counts()).toEqual(before);
  });

  it('refuses broken, oversized and too long files; handles a larger synthetic list', async () => {
    const quote = await upload(
      people.a.cookie,
      '/imports/inspect',
      'Název;Poznámka\r\nA;"neukončená\r\n',
    );
    expect(quote.status).toBe(422);
    expect(quote.body).toMatchObject({ code: 'CSV_UNTERMINATED_QUOTE', details: { line: 2 } });
    expect((await upload(people.a.cookie, '/imports/inspect', '\r\n')).body.code).toBe('CSV_EMPTY');
    expect((await upload(people.a.cookie, '/imports/inspect', 'Název;Země\r\n')).body.code).toBe(
      'CSV_NO_DATA',
    );
    expect(
      (await http().post(`${base}/imports/inspect`).set('Cookie', people.a.cookie)).status,
    ).toBe(400);
    const tooMany =
      'Název;Země\r\n' + Array.from({ length: 2001 }, (_, i) => `H${i};CZ`).join('\r\n');
    expect((await upload(people.a.cookie, '/imports/inspect', tooMany)).body).toMatchObject({
      code: 'IMPORT_TOO_MANY_ROWS',
      details: { limit: 2000, rows: 2001 },
    });
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
    expect((await upload(people.a.cookie, '/imports/inspect', huge)).status).toBe(413);
    // A wrong mapping is refused (every column once; the name must be mapped).
    const csv = 'Název;Země\r\nA;CZ\r\n';
    expect(
      (await upload(people.a.cookie, '/imports/preview', csv, options(['name']))).body.code,
    ).toBe('IMPORT_MAPPING_MISMATCH');
    expect(
      (await upload(people.a.cookie, '/imports/preview', csv, options(['name', 'name']))).body.code,
    ).toBe('IMPORT_MAPPING_DUPLICATE');
    expect(
      (await upload(people.a.cookie, '/imports/preview', csv, options(['city', 'countryCode'])))
        .body.code,
    ).toBe('IMPORT_NAME_NOT_MAPPED');

    // 1500 synthetic rows (comma-separated this time): preview and one transaction.
    const big =
      'name,country,city,phone\n' +
      Array.from(
        { length: 1500 },
        (_, i) =>
          `Velký seznam ${tag} ${String(i).padStart(4, '0')},CZ,Město ${i % 7},+420 600 ${String(i).padStart(6, '0')}`,
      ).join('\n');
    const opts = options(['name', 'countryCode', 'city', 'contactPhone'], {
      defaults: { countryCode: null, contactLabel: 'Recepce' },
    });
    const prev = (await upload(people.b.cookie, '/imports/preview', big, opts).expect(200))
      .body as ImportPreview;
    expect(prev.counts).toMatchObject({ total: 1500, valid: 1500, withDuplicates: 0 });
    const res = (
      await upload(people.b.cookie, '/imports', big, {
        ...opts,
        requestId: randomUUID(),
        rows: prev.rows.map((r) => ({ row: r.row, acknowledgeDuplicates: false })),
      }).expect(201)
    ).body as ImportResult;
    expect(res.createdCount).toBe(1500);
    const page = (
      await http()
        .get(`${base}/prospects?q=${encodeURIComponent(`Velký seznam ${tag}`)}`)
        .set('Cookie', people.b.cookie)
        .expect(200)
    ).body as ProspectPage;
    expect(page.total).toBe(1500);
  }, 120_000);

  it('exports the filtered list in scope, all pages, safe against formulas', async () => {
    const make = async (cookie: string, name: string, extra: object = {}) =>
      (
        await http()
          .post(`${base}/prospects`)
          .set('Cookie', cookie)
          .send({
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
            acknowledgeDuplicates: true,
            ...extra,
          })
          .expect(201)
      ).body as ProspectDetail;
    const mark = `Export ${tag}`;
    for (let i = 0; i < 30; i++)
      await make(people.a.cookie, `${mark} ${String(i).padStart(2, '0')}`);
    const evil = await make(people.a.cookie, `=HYPERLINK("http://x.test";"${mark}")`, {
      city: '@SUM(A1)',
      contact: {
        label: '-Recepce',
        position: null,
        email: null,
        phone: '+420 777 999 000',
        note: null,
        isPrimary: true,
      },
    });
    await make(people.b.cookie, `${mark} cizí`, {
      contact: {
        label: 'Tajná osoba',
        position: null,
        email: `tajna-${tag}@cizi.test`,
        phone: null,
        note: null,
        isPrimary: true,
      },
    });
    const get = (cookie: string, qs: string) =>
      http()
        .get(`${base}/prospects/export?${qs}`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
        });
    const res = await get(people.a.cookie, `q=${encodeURIComponent(mark)}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="zajemci-/);
    const text = res.body as string;
    expect(text.startsWith('\uFEFFKód;Název;Země;Město')).toBe(true);
    const lines = text.trim().split('\r\n');
    // All pages (31 > 25), own prospects only — no other salesperson's name or contact.
    expect(lines).toHaveLength(1 + 31);
    expect(text).not.toContain('cizí');
    expect(text).not.toContain('Tajná osoba');
    // Formulas are neutralised in the file only; the database keeps the original values.
    expect(text).toContain(`"'=HYPERLINK(""http://x.test"";""${mark}"")"`);
    expect(text).toContain(";'@SUM(A1);");
    expect(text).toContain(";'-Recepce;");
    expect(text).toContain(";'+420 777 999 000;");
    const stored = await t.prisma.salesProspect.findUniqueOrThrow({ where: { code: evil.code } });
    expect(stored.name).toBe(`=HYPERLINK("http://x.test";"${mark}")`);
    // Filters apply; ADMIN chooses the scope.
    const none = await get(people.a.cookie, `q=${encodeURIComponent(mark)}&stage=WON`).expect(200);
    expect((none.body as string).trim().split('\r\n')).toHaveLength(1);
    const adminAll = await get(admin, `q=${encodeURIComponent(mark)}`).expect(200);
    expect((adminAll.body as string).trim().split('\r\n')).toHaveLength(1 + 32);
    const adminB = await get(admin, `q=${encodeURIComponent(mark)}&owner=${people.b.id}`).expect(
      200,
    );
    expect((adminB.body as string).trim().split('\r\n')).toHaveLength(2);
    // A salesperson's owner filter cannot widen the export.
    const widened = await get(
      people.a.cookie,
      `q=${encodeURIComponent(mark)}&owner=${people.b.id}`,
    ).expect(200);
    expect(widened.body as string).not.toContain('cizí');

    // Our own export imports back: the phone keeps its "+", the formula escape is removed.
    const insp = (await upload(people.a.cookie, '/imports/inspect', text).expect(200))
      .body as ImportInspection;
    expect(insp.suggested.slice(0, 4)).toEqual(['ignore', 'name', 'countryCode', 'city']);
    const prev = (
      await upload(people.a.cookie, '/imports/preview', text, options(insp.suggested)).expect(200)
    ).body as ImportPreview;
    const back = prev.rows.find((r) => r.name?.startsWith('=HYPERLINK'))!;
    expect(back.contact).toMatchObject({ label: '-Recepce', phone: '+420 777 999 000' });
    expect(back.errors).toEqual([]);
    // Every row is a duplicate of the exported prospect — nothing would be merged silently.
    expect(prev.counts.withDuplicates).toBe(31);
  });
});
