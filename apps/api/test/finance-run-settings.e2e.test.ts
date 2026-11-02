import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillingRunSettingsPage, TestRunPlan } from '@ayvo/types';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase } from './support/test-app.js';

/**
 * The settings of the monthly invoicing run (owner 2026-11-02, doc 040 §11, §13): no default (no
 * version → nothing planned), versions with a reason made from the newest one seen, append-only,
 * the plan of an issue month (issue date and billed month per billing timing, across a year) and
 * the permissions. The settings are one per installation: the tests build on each other in order.
 */
const S = '/api/admin/finance/billing/run-settings';
const PLAN = '/api/admin/finance/invoices/test-run/plan';

describe.skipIf(!hasDatabase)('finance run settings (doc 040 §11, §13)', () => {
  let f: FinanceTestApp;
  beforeAll(async () => {
    f = await createFinanceTestApp();
  });
  afterAll(async () => {
    await f?.close();
  });

  const version = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedRevision: null,
    issueDay: 1,
    advanceBilledMonth: 'ISSUE_MONTH',
    arrearsBilledMonth: 'PREVIOUS_MONTH',
    reason: 'Jako UOL: 1. dne za daný měsíc (test)',
    ...over,
  });
  const plan = async (issueMonth: string) =>
    (await f.get(`${PLAN}?issueMonth=${issueMonth}`).expect(200)).body as TestRunPlan;

  it('without settings nothing is planned; nothing is assumed', async () => {
    const page = (await f.get(S).expect(200)).body as BillingRunSettingsPage;
    expect(page).toEqual({ current: null, versions: [] });
    expect(await plan('2026-12')).toEqual({
      issueMonth: '2026-12',
      settingsRevision: null,
      issuedOn: null,
      groups: [],
    });
  });

  it('every value is required and bounded; a version is made from the newest one seen', async () => {
    for (const bad of [
      { issueDay: 29 },
      { issueDay: 0 },
      { advanceBilledMonth: 'PREVIOUS_MONTH' },
      { arrearsBilledMonth: 'NEXT_MONTH' },
      { reason: '' },
      { issueDay: undefined },
    ])
      await f.post(S).send(version(bad)).expect(400);
    const first = version();
    const created = (await f.post(S).send(first).expect(201)).body as BillingRunSettingsPage;
    expect(created.current).toMatchObject({
      issueDay: 1,
      advanceBilledMonth: 'ISSUE_MONTH',
      arrearsBilledMonth: 'PREVIOUS_MONTH',
    });
    // Replayed: the same answer, no second version.
    expect((await f.post(S).send(first).expect(201)).body).toEqual(created);
    // A form that saw no version (or an older one) is refused.
    const stale = await f.post(S).send(version({ issueDay: 5 }));
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    const second = (
      await f
        .post(S)
        .send(
          version({
            expectedRevision: created.current!.revision,
            issueDay: 15,
            advanceBilledMonth: 'NEXT_MONTH',
            arrearsBilledMonth: 'ISSUE_MONTH',
            reason: 'Placení za následující měsíc (test)',
          }),
        )
        .expect(201)
    ).body as BillingRunSettingsPage;
    expect(second.versions.map((v) => v.issueDay)).toEqual([15, 1]);
    expect(second.current!.revision).toBeGreaterThan(created.current!.revision);
  });

  it('the plan: issue date and billed months by the newest settings, across a year', async () => {
    expect(await plan('2026-12')).toMatchObject({
      issuedOn: '2026-12-15',
      groups: [
        { billingTiming: 'ADVANCE', billedMonth: '2027-01' },
        { billingTiming: 'ARREARS', billedMonth: '2026-12' },
      ],
    });
    const page = (await f.get(S).expect(200)).body as BillingRunSettingsPage;
    await f
      .post(S)
      .send(version({ expectedRevision: page.current!.revision, reason: 'Zpět (test)' }))
      .expect(201);
    expect(await plan('2027-01')).toMatchObject({
      issuedOn: '2027-01-01',
      groups: [
        { billingTiming: 'ADVANCE', billedMonth: '2027-01' },
        { billingTiming: 'ARREARS', billedMonth: '2026-12' },
      ],
    });
    await f.get(`${PLAN}?issueMonth=2026-13`).expect(400);
    await f.get(PLAN).expect(400);
  });

  it('versions are append-only, also for the schema owner', async () => {
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      await expect(
        owner.$executeRawUnsafe(`UPDATE finance.billing_run_settings SET issue_day = 2`),
      ).rejects.toThrow();
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM finance.billing_run_settings`),
      ).rejects.toThrow();
      await expect(
        owner.$executeRawUnsafe(`TRUNCATE finance.billing_run_settings`),
      ).rejects.toThrow();
    } finally {
      await owner.$disconnect();
    }
  });

  it('reading needs finance:billing_read, a change finance:billing_manage, the plan also invoices_test', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const roleCode = `FINR_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Jen čtení smluv (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.create({
        data: { roleCode, permissionCode: 'finance:billing_read' },
      });
      const user = await prepareInvitedUser(real.core, {
        email: `run-settings-${randomUUID()}@ayvo.test`,
        displayName: 'Jen čtení smluv',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: read only' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(S, cookie).expect(200);
      await real.post(S, cookie).send(version()).expect(403);
      await real.get(`${PLAN}?issueMonth=2026-12`, cookie).expect(403);
    } finally {
      await real.close();
    }
  });
});
