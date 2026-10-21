import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  CurrentUser,
  DuplicateHint,
  ProspectDetail,
  ProspectPage,
  SalesOverview,
  TaskPage,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, salesToday } from '../src/sales/sales-access.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Obchod — hotel acquisition (doc 034) through the real sign-in: salespeople with the SALES role
 * only (no site), ownership checked on every read and write, append-only history, idempotent and
 * revision-checked writes. Nothing outside Obchod is created.
 */
describe.skipIf(!hasDatabase)('Obchod (sales acquisition)', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b', { id: string; cookie: string; name: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const as = (cookie: string) => ({
    get: (path: string) => http().get(`/api/admin/sales${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      http()
        .post(`/api/admin/sales${path}`)
        .set('Cookie', cookie)
        .send({ requestId: randomUUID(), ...body }),
  });
  const tag = randomUUID().slice(0, 6);
  const today = () => salesToday();

  const prospect = (name: string, extra: object = {}) => ({
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
  const contact = (label: string, extra: object = {}) => ({
    revision: null,
    label,
    position: null,
    email: null,
    phone: null,
    note: null,
    isPrimary: false,
    ...extra,
  });
  async function create(cookie: string, name: string, extra: object = {}) {
    const res = await as(cookie).post('/prospects', prospect(name, extra));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ProspectDetail;
  }
  const counts = async () => ({
    hotels: await t.prisma.hotel.count(),
    orders: await t.prisma.order.count(),
    movements: await t.prisma.inventoryMovement.count(),
    shipments: await t.prisma.shipment.count(),
  });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('sales-admin'),
      displayName: 'Admin Obchodu',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    for (const [key, name] of [
      ['a', 'Obchodník Adam'],
      ['b', 'Obchodnice Bára'],
    ] as const) {
      const email = unique(`sales-${key}`);
      // SALES only, without any site (doc 034 §7).
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

  it('a SALES-only account signs in without a site and sees only Obchod', async () => {
    const me = (await http().get('/api/auth/me').set('Cookie', people.a.cookie).expect(200))
      .body as CurrentUser;
    expect(me.permissions).toEqual(['sales:work']);
    expect(me.sites).toEqual([]);
    expect(me.activeSiteId).toBeNull();
    await as(people.a.cookie).get('/overview').expect(200);
    for (const path of [
      '/api/admin/inventory/stock-summary',
      '/api/admin/inventory/stock',
      '/api/admin/goods-receipts',
      '/api/admin/orders',
      '/api/admin/hotels',
      '/api/admin/identity/users',
    ]) {
      expect((await http().get(path).set('Cookie', people.a.cookie)).status, path).toBe(403);
    }
  });

  it('the whole way: quick prospect → contact → yesterday’s call → follow-up → done → offer → won', async () => {
    const before = await counts();
    const a = as(people.a.cookie);
    // Quick creation: a name and a country; unknown rooms stay unknown.
    const created = await create(people.a.cookie, `Penzion Pod Lesem ${tag}`, {
      countryCode: 'AT',
    });
    expect(created).toMatchObject({
      stage: 'NEW',
      roomsEstimate: null,
      owner: { id: people.a.id },
    });
    expect(created.firstContactAt).toBeNull();
    const code = created.code;
    expect(code).toMatch(/^AKV-\d{6}$/);

    // A contact known only as the reception, with a foreign number.
    let d = (
      await a
        .post(
          `/prospects/${code}/contacts`,
          contact('Recepce', { phone: '+43 (0)662 123 456', isPrimary: true }),
        )
        .expect(200)
    ).body as ProspectDetail;
    const reception = d.contacts[0]!;
    expect(reception).toMatchObject({
      label: 'Recepce',
      isPrimary: true,
      phone: '+43 (0)662 123 456',
    });

    // Adding a task or editing the profile is not contacting the hotel.
    d = (
      await a
        .post(`/prospects/${code}/tasks`, {
          title: 'Najít web',
          dueOn: addDays(today(), 1),
          contactId: null,
          assigneeId: null,
          note: null,
        })
        .expect(200)
    ).body;
    expect(d.firstContactAt).toBeNull();

    // Yesterday's call, recorded today, with the next step on Friday (any day ahead).
    const yesterday = addDays(today(), -1);
    d = (
      await a
        .post(`/prospects/${code}/activities`, {
          kind: 'CALL',
          occurredAt: `${yesterday}T14:30`,
          contactId: reception.id,
          content: 'Volal jsem provoznímu, má zájem o vzorky. Rozhoduje ředitelka.',
          outcome: 'Domluveno zavolat v pátek.',
          followUp: {
            title: 'Zavolat ředitelce',
            dueOn: addDays(today(), 3),
            contactId: reception.id,
          },
        })
        .expect(200)
    ).body;
    const call = d.activities[0]!;
    expect(call).toMatchObject({
      kind: 'CALL',
      author: people.a.name,
      contact: { label: 'Recepce' },
    });
    // The real time of the call in Europe/Prague, not the time of recording.
    expect(
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Prague',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(call.occurredAt)),
    ).toBe(`${yesterday} 14:30`);
    expect(call.recordedAt > call.occurredAt).toBe(true);
    expect(d.firstContactAt).toBe(call.occurredAt);
    expect(d.lastContactAt).toBe(call.occurredAt);
    // Recording a call does not change the stage.
    expect(d.stage).toBe('NEW');
    expect(d.openTasks.map((x) => x.title)).toEqual(['Najít web', 'Zavolat ředitelce']);

    // The list shows the nearest open task and the last contact.
    const page = (await a.get(`/prospects?q=${encodeURIComponent('Pod Lesem ' + tag)}`).expect(200))
      .body as ProspectPage;
    expect(page.items[0]).toMatchObject({
      code,
      nextTask: { title: 'Najít web' },
      lastContactAt: call.occurredAt,
      openTasks: 2,
    });

    // Completing a task never changes the stage.
    const followUp = d.openTasks.find((x) => x.title === 'Zavolat ředitelce')!;
    d = (
      await a
        .post(`/tasks/${followUp.id}/done`, {
          revision: followUp.revision,
          result: 'Ředitelka chce nabídku',
        })
        .expect(200)
    ).body;
    expect(d.stage).toBe('NEW');
    expect(d.closedTasks[0]).toMatchObject({
      status: 'DONE',
      result: 'Ředitelka chce nabídku',
      closedBy: people.a.name,
    });
    // A closed task stays closed.
    const again = await a.post(`/tasks/${followUp.id}/done`, {
      revision: followUp.revision + 1,
      result: null,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TASK_CLOSED');

    // Forward needs no reason; the offer is an activity, the stage change is not.
    d = (
      await a
        .post(`/prospects/${code}/stage`, {
          revision: d.revision,
          stage: 'OFFER',
          reason: null,
          lostReason: null,
        })
        .expect(200)
    ).body;
    d = (
      await a
        .post(`/prospects/${code}/activities`, {
          kind: 'OFFER',
          occurredAt: `${today()}T00:00`,
          contactId: null,
          content: 'Nabídka na 40 pokojů předána osobně',
          outcome: null,
          followUp: null,
        })
        .expect(200)
    ).body;
    d = (
      await a
        .post(`/prospects/${code}/stage`, {
          revision: d.revision,
          stage: 'WON',
          reason: null,
          lostReason: null,
        })
        .expect(200)
    ).body;
    expect(d.stage).toBe('WON');
    const stageEvents = d.events
      .filter((e) => e.type === 'STAGE_CHANGED')
      .map((e) => [e.payload.from, e.payload.to]);
    expect(stageEvents).toEqual([
      ['OFFER', 'WON'],
      ['NEW', 'OFFER'],
    ]);
    // A stage change never pretends an e-mail or call: the activities are only what was recorded.
    expect(d.activities.map((x) => x.kind)).toEqual(['OFFER', 'CALL']);
    // "Získaný" creates nothing outside Obchod.
    expect(await counts()).toEqual(before);
  });

  it('reopening, lost reasons and corrections stay traceable; history is never rewritten', async () => {
    const a = as(people.a.cookie);
    let d = await create(people.a.cookie, `Hotel Na Kopci ${tag}`);
    const code = d.code;
    d = (
      await a
        .post(`/prospects/${code}/stage`, {
          revision: d.revision,
          stage: 'NEGOTIATION',
          reason: null,
          lostReason: null,
        })
        .expect(200)
    ).body;
    const noLost = await a.post(`/prospects/${code}/stage`, {
      revision: d.revision,
      stage: 'LOST',
      reason: null,
      lostReason: null,
    });
    expect(noLost.body.code).toBe('LOST_REASON_REQUIRED');
    d = (
      await a
        .post(`/prospects/${code}/stage`, {
          revision: d.revision,
          stage: 'LOST',
          reason: null,
          lostReason: 'Mají smlouvu s konkurencí do 2027',
        })
        .expect(200)
    ).body;
    expect(d.lostReason).toBe('Mají smlouvu s konkurencí do 2027');
    // Reopening needs a reason; the lost reason goes, its history stays.
    const noReason = await a.post(`/prospects/${code}/stage`, {
      revision: d.revision,
      stage: 'NEGOTIATION',
      reason: null,
      lostReason: null,
    });
    expect(noReason.body.code).toBe('STAGE_REASON_REQUIRED');
    d = (
      await a
        .post(`/prospects/${code}/stage`, {
          revision: d.revision,
          stage: 'NEGOTIATION',
          reason: 'Nový ředitel se ozval sám',
          lostReason: null,
        })
        .expect(200)
    ).body;
    expect(d.lostReason).toBeNull();
    const reopen = d.events.find((e) => e.type === 'STAGE_CHANGED')!;
    expect(reopen.payload).toMatchObject({
      from: 'LOST',
      to: 'NEGOTIATION',
      reason: 'Nový ředitel se ozval sám',
      previousLostReason: 'Mají smlouvu s konkurencí do 2027',
    });

    // A correction is a new version with a reason; the original stays visible.
    d = (
      await a
        .post(`/prospects/${code}/activities`, {
          kind: 'EMAIL_SENT',
          occurredAt: `${today()}T00:01`,
          contactId: null,
          content: 'Poslán ceník',
          outcome: null,
          followUp: null,
        })
        .expect(200)
    ).body;
    const original = d.activities[0]!;
    d = (
      await a
        .post(`/prospects/${code}/activities/${original.id}/correct`, {
          withdraw: false,
          kind: 'EMAIL_RECEIVED',
          occurredAt: `${today()}T00:01`,
          contactId: null,
          content: 'Přišel dotaz na ceník',
          outcome: null,
          reason: 'Byl to přijatý e-mail',
        })
        .expect(200)
    ).body;
    expect(d.activities).toHaveLength(1);
    expect(d.activities[0]).toMatchObject({
      kind: 'EMAIL_RECEIVED',
      correctionReason: 'Byl to přijatý e-mail',
      earlier: [{ id: original.id, kind: 'EMAIL_SENT', content: 'Poslán ceník' }],
    });
    // The old version cannot be corrected again (no fork); the current one can be withdrawn.
    const stale = await a.post(`/prospects/${code}/activities/${original.id}/correct`, {
      withdraw: true,
      reason: 'pozdě',
    });
    expect(stale.status).toBe(409);
    d = (
      await a
        .post(`/prospects/${code}/activities/${d.activities[0]!.id}/correct`, {
          withdraw: true,
          reason: 'Zapsáno k jinému hotelu',
        })
        .expect(200)
    ).body;
    expect(d.activities[0]).toMatchObject({
      withdrawn: true,
      content: null,
      correctionReason: 'Zapsáno k jinému hotelu',
    });
    expect(d.activities[0]!.earlier).toHaveLength(2);
    // A withdrawn e-mail is not a contact.
    expect(d.lastContactAt).toBeNull();
    // A future activity is refused; the database refuses rewriting history.
    const future = await a.post(`/prospects/${code}/activities`, {
      kind: 'CALL',
      occurredAt: `${addDays(today(), 2)}T10:00`,
      contactId: null,
      content: 'x',
      outcome: null,
      followUp: null,
    });
    expect(future.body.code).toBe('ACTIVITY_IN_FUTURE');
    const row = await t.prisma.salesActivity.findFirstOrThrow({ where: { id: original.id } });
    await expect(
      t.prisma.salesActivity.update({ where: { id: row.id }, data: { content: 'tiše' } }),
    ).rejects.toThrow();
    await expect(t.prisma.salesActivity.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(
      t.prisma.salesEvent.deleteMany({ where: { prospect: { code } } }),
    ).rejects.toThrow();
    await expect(t.prisma.salesProspect.delete({ where: { code } })).rejects.toThrow();
  });

  it('several contacts and tasks: one main contact, retirement with a reason, the nearest task first', async () => {
    const a = as(people.a.cookie);
    let d = await create(people.a.cookie, `Hotel Tři Lípy ${tag}`, {
      contact: {
        label: 'Recepce',
        position: null,
        email: `recepce-${tag}@lipy.test`,
        phone: null,
        note: null,
        isPrimary: true,
      },
    });
    const code = d.code;
    d = (
      await a
        .post(
          `/prospects/${code}/contacts`,
          contact('Jana Nováková', { position: 'Ředitelka', isPrimary: true }),
        )
        .expect(200)
    ).body;
    expect(d.contacts.filter((c) => c.isPrimary).map((c) => c.label)).toEqual(['Jana Nováková']);
    const reception = d.contacts.find((c) => c.label === 'Recepce')!;
    d = (
      await a
        .post(`/prospects/${code}/contacts/${reception.id}/retire`, {
          revision: reception.revision,
          reason: 'Recepce už nekomunikuje',
        })
        .expect(200)
    ).body;
    expect(d.contacts.find((c) => c.id === reception.id)!.retired).toMatchObject({
      reason: 'Recepce už nekomunikuje',
    });
    const onRetired = await a.post(`/prospects/${code}/tasks`, {
      title: 'x',
      dueOn: today(),
      contactId: reception.id,
      assigneeId: null,
      note: null,
    });
    expect(onRetired.body.code).toBe('CONTACT_RETIRED');

    for (const [title, days] of [
      ['Poslat vzorky', 5],
      ['Zavolat', 0],
      ['Schůzka', 2],
    ] as const) {
      d = (
        await a
          .post(`/prospects/${code}/tasks`, {
            title,
            dueOn: addDays(today(), days),
            contactId: null,
            assigneeId: null,
            note: null,
          })
          .expect(200)
      ).body;
    }
    expect(d.openTasks.map((x) => x.title)).toEqual(['Zavolat', 'Schůzka', 'Poslat vzorky']);
    const past = await a.post(`/prospects/${code}/tasks`, {
      title: 'x',
      dueOn: addDays(today(), -1),
      contactId: null,
      assigneeId: null,
      note: null,
    });
    expect(past.body.code).toBe('DUE_IN_PAST');
    // Rescheduling and cancelling are recorded; a cancellation needs its reason.
    const call = d.openTasks[0]!;
    d = (
      await a
        .post(`/tasks/${call.id}/reschedule`, {
          revision: call.revision,
          dueOn: addDays(today(), 7),
          reason: 'Ředitelka je na dovolené',
        })
        .expect(200)
    ).body;
    expect(d.openTasks.map((x) => x.title)).toEqual(['Schůzka', 'Poslat vzorky', 'Zavolat']);
    const meeting = d.openTasks[0]!;
    expect(
      (await a.post(`/tasks/${meeting.id}/cancel`, { revision: meeting.revision, reason: '' }))
        .status,
    ).toBe(400);
    d = (
      await a
        .post(`/tasks/${meeting.id}/cancel`, {
          revision: meeting.revision,
          reason: 'Hotel nechce schůzku',
        })
        .expect(200)
    ).body;
    const types = d.events.map((e) => e.type);
    expect(types).toContain('TASK_RESCHEDULED');
    expect(types).toContain('TASK_CANCELLED');
    expect(types).toContain('CONTACT_RETIRED');
    expect(d.events.find((e) => e.type === 'TASK_RESCHEDULED')!.payload).toMatchObject({
      from: today(),
      to: addDays(today(), 7),
      reason: 'Ředitelka je na dovolené',
    });
    // The overview: my task of today is gone after the move; the moved one is upcoming.
    const overview = (await a.get('/overview').expect(200)).body as SalesOverview;
    expect(overview.upcoming.map((x) => x.id)).toContain(call.id);
  });

  it('concurrent edits never silently overwrite each other', async () => {
    const a = as(people.a.cookie);
    const d = await create(people.a.cookie, `Hotel Souběh ${tag}`);
    const edit = (city: string) =>
      a.post(`/prospects/${d.code}/update`, {
        ...prospect(d.name),
        revision: d.revision,
        city,
        ownerId: undefined,
        contact: undefined,
        acknowledgeDuplicates: undefined,
      });
    const [one, two] = await Promise.all([edit('Brno'), edit('Olomouc')]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body).toMatchObject({ code: 'PROSPECT_CHANGED', details: { revision: 2 } });
    const after = (await a.get(`/prospects/${d.code}`).expect(200)).body as ProspectDetail;
    expect(after.revision).toBe(2);
    const winner = one.status === 200 ? 'Brno' : 'Olomouc';
    expect(after.city).toBe(winner);
    expect(after.events.find((e) => e.type === 'PROSPECT_UPDATED')!.payload).toEqual({
      changes: { city: { before: null, after: winner } },
    });
  });

  it('a repeated click creates nothing twice', async () => {
    const requestId = randomUUID();
    const body = { requestId, ...prospect(`Hotel Dvojklik ${tag}`) };
    const [x, y] = await Promise.all([
      http().post('/api/admin/sales/prospects').set('Cookie', people.a.cookie).send(body),
      http().post('/api/admin/sales/prospects').set('Cookie', people.a.cookie).send(body),
    ]);
    expect(x.body.code).toBe(y.body.code);
    expect(await t.prisma.salesProspect.count({ where: { name: `Hotel Dvojklik ${tag}` } })).toBe(
      1,
    );
  });

  it("another salesperson's prospects stay invisible — by URL, API, search, counts and duplicates", async () => {
    const a = as(people.a.cookie);
    const b = as(people.b.cookie);
    const email = `reditel-${tag}@tajny.test`;
    let d = await create(people.a.cookie, `Hotel Tajný ${tag}`, {
      city: 'Kroměříž',
      website: `https://www.tajny-${tag}.test/cs`,
      contact: {
        label: 'Petr Tajný',
        position: 'Ředitel',
        email,
        phone: '+420 777 000 111',
        note: null,
        isPrimary: true,
      },
    });
    d = (
      await a
        .post(`/prospects/${d.code}/tasks`, {
          title: 'Tajný úkol',
          dueOn: today(),
          contactId: null,
          assigneeId: null,
          note: null,
        })
        .expect(200)
    ).body;
    const task = d.openTasks[0]!;
    const code = d.code;

    expect((await b.get(`/prospects/${code}`)).status).toBe(404);
    for (const q of ['Tajný', 'Kroměříž', email, '777000111', code]) {
      const page = (await b.get(`/prospects?q=${encodeURIComponent(q)}`).expect(200))
        .body as ProspectPage;
      expect(
        page.items.map((x) => x.code),
        q,
      ).not.toContain(code);
    }
    // An owner filter cannot widen the view without sales:manage.
    const widened = (await b.get(`/prospects?owner=${people.a.id}`).expect(200))
      .body as ProspectPage;
    expect(widened.items.every((x) => x.owner.id === people.b.id)).toBe(true);
    expect((await b.get('/tasks?assignee=all')).status).toBe(403);
    const bOverview = (await b.get('/overview?scope=all').expect(200)).body as SalesOverview;
    expect(bOverview.scope).toBe('me');
    expect(JSON.stringify(bOverview)).not.toContain('Tajný');
    for (const [path, body] of [
      [
        `/prospects/${code}/activities`,
        {
          kind: 'NOTE',
          occurredAt: `${today()}T00:00`,
          contactId: null,
          content: 'x',
          outcome: null,
          followUp: null,
        },
      ],
      [`/prospects/${code}/contacts`, contact('x')],
      [
        `/prospects/${code}/stage`,
        { revision: d.revision, stage: 'CONTACTED', reason: null, lostReason: null },
      ],
      [`/tasks/${task.id}/done`, { revision: task.revision, result: null }],
    ] as const) {
      expect((await b.post(path, body)).status, path).toBe(404);
    }
    expect(
      (
        await b.post(`/prospects/${code}/owner`, {
          revision: d.revision,
          ownerId: people.b.id,
          reason: null,
        })
      ).status,
    ).toBe(403);
    expect((await b.get('/salespeople')).status).toBe(403);
    // A salesperson cannot hand a new prospect to someone else.
    expect(
      (await b.post('/prospects', prospect(`Cizí ${tag}`, { ownerId: people.a.id }))).status,
    ).toBe(403);

    // The duplicate warning names nothing of A's prospect to B: a count only.
    for (const extra of [
      {},
      { website: `tajny-${tag}.test` },
      {
        contact: {
          label: 'Recepce',
          position: null,
          email: email.toUpperCase(),
          phone: null,
          note: null,
          isPrimary: false,
        },
      },
    ]) {
      const dup = await b.post('/prospects', prospect(`Tajný hotel ${tag}`, extra));
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
      expect(dup.body.details).toEqual({ accessible: [], hidden: 1 });
      expect(JSON.stringify(dup.body)).not.toMatch(/Kroměříž|Petr|reditel|AKV-/);
    }
    // A shared e-mail is allowed after the explicit confirmation (chains, one contact person).
    await create(people.b.cookie, `Tajný hotel ${tag}`, { acknowledgeDuplicates: true });
    // The owner sees the duplicate with its name; nothing was merged.
    const hint = (
      await a
        .get(
          `/prospects/duplicates?name=${encodeURIComponent(`Tajný hotel ${tag}`)}&countryCode=CZ`,
        )
        .expect(200)
    ).body as DuplicateHint;
    expect(hint).toEqual({
      accessible: [expect.objectContaining({ code, reasons: ['NAME'] })],
      hidden: 1,
    });

    // ADMIN sees all and reassigns: the open task moves along, A loses access, B gains it.
    const all = (
      await as(admin)
        .get(`/prospects?q=${encodeURIComponent('Tajný')}`)
        .expect(200)
    ).body as ProspectPage;
    expect(all.items.map((x) => x.code)).toContain(code);
    const people_ = (await as(admin).get('/salespeople').expect(200)).body as { id: string }[];
    expect(people_.map((p) => p.id)).toEqual(expect.arrayContaining([people.a.id, people.b.id]));
    const notSales = await as(admin).post(`/prospects/${code}/owner`, {
      revision: d.revision,
      ownerId: (
        await t.prisma.user.create({ data: { email: unique('nobody'), displayName: 'Nikdo' } })
      ).id,
      reason: null,
    });
    expect(notSales.body.code).toBe('NOT_A_SALESPERSON');
    const moved = (
      await as(admin)
        .post(`/prospects/${code}/owner`, {
          revision: d.revision,
          ownerId: people.b.id,
          reason: 'Převzetí regionu',
        })
        .expect(200)
    ).body as ProspectDetail;
    expect(moved.owner.id).toBe(people.b.id);
    expect(moved.openTasks[0]!.assignee.id).toBe(people.b.id);
    expect(moved.events[0]).toMatchObject({
      type: 'OWNER_CHANGED',
      payload: { reason: 'Převzetí regionu', movedTasks: 1 },
    });
    expect((await a.get(`/prospects/${code}`)).status).toBe(404);
    await b.get(`/prospects/${code}`).expect(200);
    const bTasks = (await b.get('/tasks').expect(200)).body as TaskPage;
    expect(bTasks.items.map((x) => x.id)).toContain(task.id);

    // An operational user without Obchod permissions gets nothing.
    const ops = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({
        email: unique('ops'),
        displayName: 'Skladník',
        roles: ['WAREHOUSE_SUPERVISOR'],
        siteIds: [INITIAL_SITE_ID],
        warehouseCodes: [],
        reason: 'ops',
      })
      .expect(201);
    const opsCookie = await sessionCookie(t, (ops.body as AdminUserDetail).email);
    for (const path of ['/overview', '/prospects', `/prospects/${code}`, '/tasks']) {
      expect((await as(opsCookie).get(path)).status, path).toBe(403);
    }
  });

  it('pages a larger list with totals, a stable order, filters and search', async () => {
    const a = as(people.b.cookie);
    const mark = `Strana${tag}`;
    for (let i = 0; i < 60; i++) {
      await create(people.b.cookie, `${mark} Hotel ${String(i).padStart(2, '0')}`, {
        city: i % 2 ? 'Zlín' : 'Opava',
        priority: i % 3 === 0 ? 'A' : null,
        countryCode: i % 10 === 0 ? 'SK' : 'CZ',
        acknowledgeDuplicates: true,
      });
    }
    const q = `q=${encodeURIComponent(mark)}`;
    const pages = await Promise.all(
      [1, 2, 3].map(
        async (p) => (await a.get(`/prospects?${q}&page=${p}`).expect(200)).body as ProspectPage,
      ),
    );
    expect(pages.map((p) => p.total)).toEqual([60, 60, 60]);
    expect(pages.map((p) => p.items.length)).toEqual([25, 25, 10]);
    const names = pages.flatMap((p) => p.items.map((x) => x.name));
    expect(new Set(names).size).toBe(60);
    expect(names).toEqual([...names].sort());
    const again = (await a.get(`/prospects?${q}&page=2`).expect(200)).body as ProspectPage;
    expect(again.items.map((x) => x.code)).toEqual(pages[1]!.items.map((x) => x.code));
    expect(
      ((await a.get(`/prospects?${q}&priority=A`).expect(200)).body as ProspectPage).total,
    ).toBe(20);
    expect(
      ((await a.get(`/prospects?${q}&country=SK`).expect(200)).body as ProspectPage).total,
    ).toBe(6);
    expect(
      (
        (await a.get(`/prospects?q=${encodeURIComponent(`${mark} Hotel 4`)}`).expect(200))
          .body as ProspectPage
      ).total,
    ).toBe(10);
    expect(
      ((await a.get(`/prospects?${q}&next=none`).expect(200)).body as ProspectPage).total,
    ).toBe(60);
    // A task of today puts the prospect first and into the "today" filter.
    const last = pages[2]!.items.at(-1)!;
    await a
      .post(`/prospects/${last.code}/tasks`, {
        title: 'Dnes',
        dueOn: today(),
        contactId: null,
        assigneeId: null,
        note: null,
      })
      .expect(200);
    const first = (await a.get(`/prospects?${q}`).expect(200)).body as ProspectPage;
    expect(first.items[0]!.code).toBe(last.code);
    expect(
      ((await a.get(`/prospects?${q}&next=today`).expect(200)).body as ProspectPage).items.map(
        (x) => x.code,
      ),
    ).toEqual([last.code]);
    // Beyond the last page: no items, the total stays.
    expect((await a.get(`/prospects?${q}&page=9`).expect(200)).body as ProspectPage).toMatchObject({
      items: [],
      total: 60,
    });
  });
});
