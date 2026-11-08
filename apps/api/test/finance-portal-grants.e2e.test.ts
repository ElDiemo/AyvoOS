import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FinancePortalGrantResult, PortalGrantListItem } from '@ayvo/types';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import {
  agreement,
  ensureIssuing,
  hotel,
  invoice,
  newTerms,
  payer,
} from './support/finance-portal.js';
import { hasDatabase } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const G = '/api/admin/finance/portal-grants';
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;

/**
 * Hotel portal grants through Finance (ADR 0045 §4 on `0d500f6`, PR 4a): Finance checks that the
 * hotels belong to the payer from its own data (agreement in effect today, or an invoice already
 * issued to the payer), then the core stores the grant; the account is created with its first
 * grant and invited only after the grant is written. A real core over HTTP, real DB roles,
 * synthetic payers and hotels; mail goes to the core's in-memory test transport.
 */
describe.skipIf(!hasDatabase)('hotel portal grants through Finance', () => {
  let f: FinanceTestApp;

  const issue = (payerCustomerId: string, hotelIds: string[], over: Record<string, unknown> = {}) =>
    f.post(G).send({
      requestId: randomUUID(),
      payerCustomerId,
      email: unique('portal'),
      displayName: 'Hotel Recepce',
      hotelIds,
      reason: 'Přístup do portálu (syntetický)',
      ...over,
    });
  const coreState = async (email: string) => {
    const user = await f.core.prisma.user.findUnique({ where: { email } });
    return {
      user: user?.audience ?? null,
      grants: user ? await f.core.prisma.portalGrant.count({ where: { userId: user.id } }) : 0,
    };
  };
  const mails = async (email: string) => {
    const tokens = f.core.app.get(NativeTokensService);
    await tokens.deliverPending();
    return tokens.deliveriesForTest().filter((m) => m.to === email);
  };

  beforeAll(async () => {
    f = await createFinanceTestApp({
      coreEnv: {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
      },
    });
  });
  afterAll(() => f?.close());

  it('a new grant: the pair checked, the account created, the grant written, then the invitation', async () => {
    const a = await payer(f, 'Plátce A');
    const h1 = await hotel(f);
    const h2 = await hotel(f);
    await agreement(f, a.id, h1.id);
    await agreement(f, a.id, h2.id);
    const email = unique('portal-a');
    const res = await issue(a.id, [h2.id, h1.id], { email });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as FinancePortalGrantResult;
    expect(body).toMatchObject({
      account: { email, displayName: 'Hotel Recepce' },
      invitation: 'SENT',
      grant: {
        payerCustomerId: a.id,
        hotelIds: [h1.id, h2.id].sort(),
        financeCheck: { payerVersion: 1, hotelIds: [h1.id, h2.id].sort() },
      },
    });
    expect(await coreState(email)).toEqual({ user: 'PORTAL', grants: 1 });
    // The invitation was written after the grant, and points to the portal.
    const user = await f.core.prisma.user.findUniqueOrThrow({ where: { email } });
    const grant = await f.core.prisma.portalGrant.findFirstOrThrow({ where: { userId: user.id } });
    const token = await f.core.prisma.nativeAuthToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'ENROLL' },
    });
    expect(token.createdAt.getTime()).toBeGreaterThanOrEqual(grant.grantedAt.getTime());
    const sent = await mails(email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.startsWith(`${PORTAL_ORIGIN}/activate#token=`)).toBe(true);

    // The payer's page lists it with its account.
    const list = (await f.get(`${G}?payerCustomerId=${a.id}`).expect(200))
      .body as PortalGrantListItem[];
    expect(list.map((g) => [g.id, g.account.email, g.account.signsIn])).toEqual([
      [grant.id, email, false],
    ]);
  });

  it('a retry of the same request: the same grant, one grant, one invitation', async () => {
    const a = await payer(f);
    const h = await hotel(f);
    await agreement(f, a.id, h.id);
    const body = {
      requestId: randomUUID(),
      payerCustomerId: a.id,
      email: unique('portal-retry'),
      displayName: 'Hotel Retry',
      hotelIds: [h.id],
      reason: 'Přístup (syntetický)',
    };
    const first = await f.post(G).send(body).expect(201);
    const again = await f.post(G).send(body).expect(201);
    expect(again.body.grant).toEqual(first.body.grant);
    expect(again.body.invitation).toBe('SENT');
    expect(await coreState(body.email)).toEqual({ user: 'PORTAL', grants: 1 });
    expect(await mails(body.email)).toHaveLength(1);
  });

  it('refuses a hotel of another payer, an invented payer, an ended agreement and a staff e-mail — nothing at the core', async () => {
    const a = await payer(f, 'Plátce A');
    const b = await payer(f, 'Plátce B');
    const ha = await hotel(f);
    const hb = await hotel(f);
    const ended = await hotel(f);
    await agreement(f, a.id, ha.id);
    await agreement(f, b.id, hb.id);
    await agreement(f, a.id, ended.id, { validTo: '2026-02-28' });

    const email = unique('portal-refused');
    const foreign = await issue(a.id, [ha.id, hb.id], { email });
    expect([foreign.status, foreign.body.code, foreign.body.details]).toEqual([
      409,
      'HOTEL_NOT_OF_PAYER',
      { hotelIds: [hb.id] },
    ]);
    const invented = await issue(randomUUID(), [ha.id], { email });
    expect([invented.status, invented.body.code]).toEqual([404, 'PAYER_NOT_FOUND']);
    const past = await issue(a.id, [ended.id], { email });
    expect([past.status, past.body.code]).toEqual([409, 'HOTEL_NOT_OF_PAYER']);
    // None of these reached the core: no account, no grant.
    expect(await coreState(email)).toEqual({ user: null, grants: 0 });

    // A staff e-mail (the pair is right): the core refuses the account, no grant.
    const staff = await f.core.prisma.user.create({
      data: { email: unique('staff'), displayName: 'Staff' },
    });
    const staffMail = await issue(a.id, [ha.id], { email: staff.email });
    expect([staffMail.status, staffMail.body.code]).toEqual([409, 'EMAIL_IS_STAFF']);
    expect(await coreState(staff.email)).toEqual({ user: 'STAFF', grants: 0 });
  });

  it('a hotel that moved to another payer: its old payer still has it by an issued invoice, the new one by the agreement', async () => {
    await ensureIssuing(f);
    const a = await payer(f, 'Starý plátce');
    const b = await payer(f, 'Nový plátce');
    const c = await payer(f, 'Cizí plátce');
    const h = await hotel(f, 'Hotel Přesun');
    const ag = await agreement(f, a.id, h.id);
    await invoice(f, [ag.code], '2026-09');
    await newTerms(f, ag.code, { customerId: b.id, reason: 'Hotel přešel k jinému plátci' });

    expect((await issue(a.id, [h.id])).status).toBe(201);
    expect((await issue(b.id, [h.id])).status).toBe(201);
    const other = await issue(c.id, [h.id]);
    expect([other.status, other.body.code]).toEqual([409, 'HOTEL_NOT_OF_PAYER']);
  });

  it('a replacement goes through the same check against the grant’s own payer', async () => {
    const a = await payer(f);
    const b = await payer(f);
    const h1 = await hotel(f);
    const h2 = await hotel(f);
    const hb = await hotel(f);
    await agreement(f, a.id, h1.id);
    await agreement(f, a.id, h2.id);
    await agreement(f, b.id, hb.id);
    const created = (await issue(a.id, [h1.id, h2.id]).expect(201))
      .body as FinancePortalGrantResult;

    const narrowed = await f
      .post(`${G}/${created.grant.id}/replace`)
      .send({ requestId: randomUUID(), hotelIds: [h2.id], reason: 'Zúžení (syntetické)' });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(201);
    expect(narrowed.body.grant).toMatchObject({
      replacesGrantId: created.grant.id,
      hotelIds: [h2.id],
    });

    const before = await f.core.prisma.portalGrant.count({
      where: { userId: created.grant.userId },
    });
    const foreign = await f
      .post(`${G}/${narrowed.body.grant.id}/replace`)
      .send({ requestId: randomUUID(), hotelIds: [h2.id, hb.id], reason: 'Cizí hotel' });
    expect([foreign.status, foreign.body.code]).toEqual([409, 'HOTEL_NOT_OF_PAYER']);
    // An already replaced grant: the core's answer is passed on.
    const stale = await f
      .post(`${G}/${created.grant.id}/replace`)
      .send({ requestId: randomUUID(), hotelIds: [h1.id], reason: 'Starý grant' });
    expect([stale.status, stale.body.code]).toEqual([409, 'GRANT_REPLACED']);
    expect(await f.core.prisma.portalGrant.count({ where: { userId: created.grant.userId } })).toBe(
      before,
    );
  });

  it('the core invites a portal account only once it holds an active grant', async () => {
    const user = await f.core.prisma.user.create({
      data: { email: unique('no-grant'), displayName: 'No grant', audience: 'PORTAL' },
    });
    const res = await request(f.core.app.getHttpServer())
      .post(`/api/internal/v1/finance/portal-accounts/${user.id}/invitation`)
      .set('Authorization', `Bearer ${f.env.FINANCE_SERVICE_TOKEN}`)
      .set('x-ayvo-session', 'finance-test-session')
      .send({ requestId: randomUUID() });
    expect([res.status, res.body.code]).toEqual([409, 'NO_ACTIVE_GRANT']);
    expect(await f.core.prisma.nativeAuthToken.count({ where: { userId: user.id } })).toBe(0);
  });
});
