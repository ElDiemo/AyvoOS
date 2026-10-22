import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  DuplicateHint,
  ProspectDetail,
  ProspectPage,
  SalesOverview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salesToday } from '../src/sales/sales-access.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Obchod (doc 034 §3a, §6): editing open tasks and archiving / restoring prospects, through the
 * real sign-in of SALES-only salespeople and ADMIN. Archiving is not a stage, deletes nothing and
 * cancels nothing; an archived prospect takes no new work until restored (also in the database).
 */
describe.skipIf(!hasDatabase)('Obchod — task edits and archiving', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b' | 'c', { id: string; cookie: string; name: string }> = {} as never;
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
  const task = (title: string, extra: object = {}) => ({
    title,
    dueOn: today(),
    contactId: null,
    assigneeId: null,
    note: null,
    ...extra,
  });
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
      ['c', 'Obchodník Cyril'],
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

  it('edits an open task: title, note and contact; the assignee only by ADMIN; revision kept', async () => {
    const a = as(people.a.cookie);
    let d = await create(people.a.cookie, `Hotel Úkolový ${tag}`, {
      contact: {
        label: 'Recepce',
        position: null,
        email: null,
        phone: null,
        note: null,
        isPrimary: true,
      },
    });
    const reception = d.contacts[0]!;
    d = (await a.post(`/prospects/${d.code}/contacts`, contact('Ing. Nováková')).expect(200)).body;
    const novakova = d.contacts.find((c) => c.label === 'Ing. Nováková')!;
    d = (await a.post(`/prospects/${d.code}/tasks`, task('Zavolat recepci')).expect(200)).body;
    const t0 = d.openTasks[0]!;

    // The salesperson edits title, note and contact; the history records before → after.
    const body = {
      revision: t0.revision,
      title: 'Zavolat paní Novákové',
      note: 'Rozhoduje o kosmetice',
      contactId: novakova.id,
      assigneeId: people.a.id,
    };
    const requestId = randomUUID();
    const send = () =>
      http()
        .post(`/api/admin/sales/tasks/${t0.id}/update`)
        .set('Cookie', people.a.cookie)
        .send({ requestId, ...body });
    // A double click / a retry after a lost answer: the same operation, one change.
    const [r1, r2] = await Promise.all([send(), send()]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    d = (await a.get(`/prospects/${d.code}`).expect(200)).body;
    const t1 = d.openTasks[0]!;
    expect(t1).toMatchObject({
      title: 'Zavolat paní Novákové',
      note: 'Rozhoduje o kosmetice',
      contact: { id: novakova.id },
      revision: t0.revision + 1,
      dueOn: t0.dueOn,
    });
    const updates = d.events.filter((e) => e.type === 'TASK_UPDATED');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({
      changes: {
        title: { before: 'Zavolat recepci', after: 'Zavolat paní Novákové' },
        contactId: { before: null, after: novakova.id },
      },
    });

    // A stale edit is refused with the current revision; nothing is overwritten.
    const stale = await a.post(`/tasks/${t0.id}/update`, { ...body, title: 'Přepis' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'TASK_CHANGED', details: { revision: t1.revision } });
    // Nothing changed → said so, no event.
    const same = await a.post(`/tasks/${t0.id}/update`, { ...body, revision: t1.revision });
    expect(same.body.code).toBe('TASK_UNCHANGED');

    // A salesperson never gives work to another salesperson (nor to ADMIN).
    for (const assigneeId of [people.b.id, adminId]) {
      const r = await a.post(`/tasks/${t0.id}/update`, {
        ...body,
        revision: t1.revision,
        assigneeId,
      });
      expect(r.status, assigneeId).toBe(403);
    }
    // Another salesperson does not even find the task.
    expect(
      (await as(people.b.cookie).post(`/tasks/${t0.id}/update`, { ...body, revision: 2 })).status,
    ).toBe(404);

    // ADMIN gives it to a sales administrator (here: ADMIN), never to a salesperson without access.
    const toB = await as(admin).post(`/tasks/${t0.id}/update`, {
      ...body,
      revision: t1.revision,
      assigneeId: people.b.id,
    });
    expect(toB.body.code).toBe('ASSIGNEE_WITHOUT_ACCESS');
    d = (
      await as(admin)
        .post(`/tasks/${t0.id}/update`, {
          ...body,
          revision: t1.revision,
          contactId: reception.id,
          assigneeId: adminId,
        })
        .expect(200)
    ).body;
    expect(d.openTasks[0]!.assignee.id).toBe(adminId);
    // ...and back to the owner.
    d = (
      await as(admin)
        .post(`/tasks/${t0.id}/update`, {
          ...body,
          revision: t1.revision + 1,
          contactId: reception.id,
          assigneeId: people.a.id,
        })
        .expect(200)
    ).body;

    // A closed task is not edited (a new task is created instead).
    const t2 = d.openTasks[0]!;
    await a.post(`/tasks/${t0.id}/done`, { revision: t2.revision, result: null }).expect(200);
    const closed = await a.post(`/tasks/${t0.id}/update`, { ...body, revision: t2.revision + 1 });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('TASK_CLOSED');
    // The edit never moved the due date or the stage.
    d = (await a.get(`/prospects/${d.code}`).expect(200)).body;
    expect(d.closedTasks[0]!.dueOn).toBe(t0.dueOn);
    expect(d.stage).toBe('NEW');
  });

  it('a salesperson edits a task ADMIN took over, keeping (never changing) its assignee', async () => {
    const a = as(people.a.cookie);
    let d = await create(people.a.cookie, `Hotel Převzatý úkol ${tag}`);
    d = (await a.post(`/prospects/${d.code}/tasks`, task('Poslat nabídku')).expect(200)).body;
    const t0 = d.openTasks[0]!;
    // ADMIN gives the task on A's prospect to themselves.
    d = (
      await as(admin)
        .post(`/tasks/${t0.id}/update`, {
          revision: t0.revision,
          title: t0.title,
          note: null,
          contactId: null,
          assigneeId: adminId,
        })
        .expect(200)
    ).body;
    const t1 = d.openTasks[0]!;
    expect(t1.assignee.id).toBe(adminId);

    // A changes only the title and the note; the assignee is sent back unchanged → saved.
    const kept = await a.post(`/tasks/${t0.id}/update`, {
      revision: t1.revision,
      title: 'Poslat nabídku s ceníkem',
      note: 'Po telefonu',
      contactId: null,
      assigneeId: adminId,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const t2 = (kept.body as ProspectDetail).openTasks[0]!;
    expect(t2).toMatchObject({ title: 'Poslat nabídku s ceníkem', assignee: { id: adminId } });
    const update = (kept.body as ProspectDetail).events.find(
      (e) => e.type === 'TASK_UPDATED' && e.actor === people.a.name,
    );
    expect(update?.payload).not.toHaveProperty('changes.assigneeId');

    // ...but A never changes who does it: not to themselves, not to another salesperson.
    for (const assigneeId of [people.a.id, people.b.id]) {
      const r = await a.post(`/tasks/${t0.id}/update`, {
        revision: t2.revision,
        title: t2.title,
        note: 'Po telefonu',
        contactId: null,
        assigneeId,
      });
      expect(r.status, assigneeId).toBe(403);
    }
    d = (await a.get(`/prospects/${d.code}`).expect(200)).body;
    expect(d.openTasks[0]).toMatchObject({ revision: t2.revision, assignee: { id: adminId } });
  });

  it('archives with a reason, never as a stage; refused with open tasks; restored as it was', async () => {
    const a = as(people.a.cookie);
    const before = await counts();
    let d = await create(people.a.cookie, `Penzion Archivní ${tag}`, {
      city: 'Telč',
      contact: {
        label: 'Recepce',
        position: null,
        email: `recepce-${tag}@archiv.test`,
        phone: null,
        note: null,
        isPrimary: true,
      },
    });
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
    d = (await a.post(`/prospects/${code}/tasks`, task('Poslat ceník')).expect(200)).body;
    const open = d.openTasks[0]!;

    // A reason is required.
    expect(
      (await a.post(`/prospects/${code}/archive`, { revision: d.revision, reason: '' })).status,
    ).toBe(400);
    // Open tasks: refused with the list to resolve them; nothing is cancelled automatically.
    const refused = await a.post(`/prospects/${code}/archive`, {
      revision: d.revision,
      reason: 'Založeno omylem',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'PROSPECT_HAS_OPEN_TASKS',
      details: { tasks: [{ id: open.id, title: 'Poslat ceník', dueOn: open.dueOn }] },
    });
    d = (await a.get(`/prospects/${code}`).expect(200)).body;
    expect(d.openTasks.map((x) => x.status)).toEqual(['OPEN']);
    expect(d.archived).toBeNull();

    // Another salesperson can neither archive nor restore it (it does not exist for them).
    const b = as(people.b.cookie);
    expect(
      (await b.post(`/prospects/${code}/archive`, { revision: d.revision, reason: 'cizí' })).status,
    ).toBe(404);

    // The task is resolved by a person; then the archive goes through — once, even when repeated.
    d = (
      await a
        .post(`/tasks/${open.id}/cancel`, { revision: open.revision, reason: 'Hotel zavřel' })
        .expect(200)
    ).body;
    const archiveBody = { requestId: randomUUID(), revision: d.revision, reason: 'Hotel zavřel' };
    const archiveOnce = () =>
      http()
        .post(`/api/admin/sales/prospects/${code}/archive`)
        .set('Cookie', people.a.cookie)
        .send(archiveBody);
    const [x1, x2] = await Promise.all([archiveOnce(), archiveOnce()]);
    expect([x1.status, x2.status]).toEqual([200, 200]);
    d = (await a.get(`/prospects/${code}`).expect(200)).body;
    expect(d.archived).toMatchObject({ by: people.a.name, reason: 'Hotel zavřel' });
    // Not a stage: still in negotiation, never LOST; contacts, tasks and history all stay.
    expect(d.stage).toBe('NEGOTIATION');
    expect(d.lostReason).toBeNull();
    expect(d.contacts).toHaveLength(1);
    expect(d.closedTasks).toHaveLength(1);
    expect(d.events.filter((e) => e.type === 'PROSPECT_ARCHIVED')).toHaveLength(1);
    expect(d.events.filter((e) => e.type === 'STAGE_CHANGED')).toHaveLength(1);

    // Not among the active ones (list, search, overview); available through the filter.
    const search = `?q=${encodeURIComponent('Archivní')}`;
    const active = (await a.get(`/prospects${search}`).expect(200)).body as ProspectPage;
    expect(active.items.map((x) => x.code)).not.toContain(code);
    const archived = (await a.get(`/prospects${search}&archived=archived`).expect(200))
      .body as ProspectPage;
    expect(archived.items).toEqual([
      expect.objectContaining({ code, stage: 'NEGOTIATION', archivedAt: expect.any(String) }),
    ]);
    expect(archived.total).toBe(1);
    const overview = (await a.get('/overview').expect(200)).body as SalesOverview;
    expect(overview.inProgress.map((x) => x.code)).not.toContain(code);
    // Another salesperson does not see it among their archived either.
    const bArchived = (await b.get(`/prospects${search}&archived=archived`).expect(200))
      .body as ProspectPage;
    expect(bArchived.total).toBe(0);
    // A duplicate check still finds it (restore rather than re-create) — for its owner only.
    const dup = (
      await a
        .get(
          `/prospects/duplicates?name=${encodeURIComponent(`Penzion Archivní ${tag}`)}&countryCode=CZ`,
        )
        .expect(200)
    ).body as DuplicateHint;
    expect(dup.accessible).toEqual([expect.objectContaining({ code, archived: true })]);

    // No new work on an archived prospect — by the API...
    const r = d.revision;
    for (const [path, body] of [
      [
        `/prospects/${code}/update`,
        {
          ...prospect(`Penzion Archivní ${tag}`),
          ownerId: undefined,
          contact: undefined,
          acknowledgeDuplicates: undefined,
          revision: r,
        },
      ],
      [`/prospects/${code}/stage`, { revision: r, stage: 'OFFER', reason: null, lostReason: null }],
      [`/prospects/${code}/contacts`, contact('Rezervace')],
      [
        `/prospects/${code}/contacts/${d.contacts[0]!.id}/retire`,
        { revision: d.contacts[0]!.revision, reason: 'test' },
      ],
      [
        `/prospects/${code}/activities`,
        {
          kind: 'CALL',
          occurredAt: `${today()}T00:00`,
          contactId: null,
          content: 'x',
          outcome: null,
          followUp: null,
        },
      ],
      [`/prospects/${code}/tasks`, task('Nový krok')],
    ] as const) {
      const res = await a.post(path, body);
      expect(res.status, path).toBe(409);
      expect(res.body.code, path).toBe('PROSPECT_ARCHIVED');
    }
    expect(
      (
        await as(admin).post(`/prospects/${code}/owner`, {
          revision: r,
          ownerId: people.b.id,
          reason: null,
        })
      ).body.code,
    ).toBe('PROSPECT_ARCHIVED');
    // ...and by the database itself (raw SQL, so the trigger's own message is visible).
    const row = await t.prisma.salesProspect.findUniqueOrThrow({ where: { code } });
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "sales_tasks" ("prospect_id", "title", "assignee_id", "due_on", "created_by", "updated_by")
        VALUES (${row.id}::uuid, 'Obejití', ${people.a.id}::uuid, CURRENT_DATE, ${people.a.id}::uuid, ${people.a.id}::uuid)`,
    ).rejects.toThrow(/sales_tasks of an archived prospect/);
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "sales_contacts" ("prospect_id", "label", "created_by", "updated_by")
        VALUES (${row.id}::uuid, 'Obejití', ${people.a.id}::uuid, ${people.a.id}::uuid)`,
    ).rejects.toThrow(/sales_contacts of an archived prospect/);
    await expect(
      t.prisma
        .$executeRaw`UPDATE "sales_prospects" SET "note" = 'x', "revision" = "revision" + 1 WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/archived prospect does not change/);
    await expect(t.prisma.salesProspect.delete({ where: { id: row.id } })).rejects.toThrow();
    // Archiving twice is refused; restore by another salesperson is a 404.
    expect(
      (await a.post(`/prospects/${code}/archive`, { revision: r, reason: 'znovu' })).body.code,
    ).toBe('PROSPECT_ARCHIVED');
    expect((await b.post(`/prospects/${code}/restore`, { revision: r, reason: null })).status).toBe(
      404,
    );

    // Restore: back as it was — the same stage, contacts and history; no new task or contact.
    d = (
      await a
        .post(`/prospects/${code}/restore`, { revision: r, reason: 'Hotel znovu otevřel' })
        .expect(200)
    ).body;
    expect(d.archived).toBeNull();
    expect(d.stage).toBe('NEGOTIATION');
    expect(d.openTasks).toEqual([]);
    expect(d.contacts).toHaveLength(1);
    expect(d.events[0]).toMatchObject({
      type: 'PROSPECT_RESTORED',
      payload: { reason: 'Hotel znovu otevřel', archiveReason: 'Hotel zavřel' },
    });
    expect(
      (await a.post(`/prospects/${code}/restore`, { revision: d.revision, reason: null })).body
        .code,
    ).toBe('PROSPECT_NOT_ARCHIVED');
    const again = (await a.get(`/prospects${search}`).expect(200)).body as ProspectPage;
    expect(again.items.map((x) => x.code)).toContain(code);
    // Work goes on as before.
    await a.post(`/prospects/${code}/tasks`, task('Zavolat po otevření')).expect(200);
    // The database refuses an archive with an open task, whatever the application does.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "sales_prospects" SET "archived_at" = now(), "archived_by" = ${people.a.id}::uuid,
        "archive_reason" = 'Obejití', "revision" = "revision" + 1 WHERE "code" = ${code}`,
    ).rejects.toThrow(/with open tasks is not archived/);

    // ADMIN archives and restores anyone's prospect.
    const other = await create(people.b.cookie, `Hotel Správcovský ${tag}`);
    d = (
      await as(admin)
        .post(`/prospects/${other.code}/archive`, {
          revision: other.revision,
          reason: 'Duplicitní záznam',
        })
        .expect(200)
    ).body;
    expect(d.archived).toMatchObject({ reason: 'Duplicitní záznam' });
    await as(admin)
      .post(`/prospects/${other.code}/restore`, { revision: d.revision, reason: null })
      .expect(200);

    // Nothing outside Obchod was touched.
    expect(await counts()).toEqual(before);
  });

  it('a removed Obchod permission takes effect on the next request', async () => {
    const c = as(people.c.cookie);
    const d = await create(people.c.cookie, `Hotel Odebraný ${tag}`);
    await http()
      .post(`/api/admin/identity/users/${people.c.id}/roles/revoke`)
      .set('Cookie', admin)
      .send({ role: 'SALES', reason: 'odchod z firmy' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    for (const res of [
      await c.get('/overview'),
      await c.get('/prospects'),
      await c.get(`/prospects/${d.code}`),
      await c.post(`/prospects/${d.code}/tasks`, task('Po odebrání')),
    ]) {
      expect([401, 403]).toContain(res.status);
    }
    // The prospect stays; ADMIN sees it and can hand it over.
    const kept = (await as(admin).get(`/prospects/${d.code}`).expect(200)).body as ProspectDetail;
    expect(kept.owner.id).toBe(people.c.id);
    const moved = (
      await as(admin)
        .post(`/prospects/${d.code}/owner`, {
          revision: kept.revision,
          ownerId: people.a.id,
          reason: 'Převzetí',
        })
        .expect(200)
    ).body as ProspectDetail;
    expect(moved.owner.id).toBe(people.a.id);
    await as(people.a.cookie).get(`/prospects/${d.code}`).expect(200);
    // An owner without Obchod permission is no longer offered.
    const list = (await as(admin).get('/salespeople').expect(200)).body as { id: string }[];
    expect(list.map((x) => x.id)).not.toContain(people.c.id);
  });
});
