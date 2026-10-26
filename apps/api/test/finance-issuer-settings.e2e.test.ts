import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuerSettings } from '@ayvo/types';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase } from './support/test-app.js';

/**
 * Our company (issuer) and the bank accounts printed on invoices (N3A-2a, doc 040 §8) in the
 * Finance unit, against a real core, real DB roles and synthetic data: versions with a reason,
 * stale forms refused, account number checks, one default account per currency, readiness for
 * live issuing, append-only rules and ADMIN-only access. The issuer is one per installation, so
 * the tests below build on each other in order.
 */
const I = '/api/admin/finance/issuer';

describe.skipIf(!hasDatabase)('finance issuer and invoice bank accounts (N3A-2a)', () => {
  let f: FinanceTestApp;
  const issuer = (over: Record<string, unknown> = {}) => ({
    legalName: 'Testovací vystavitel s.r.o.',
    addressLine1: 'Testovací 1',
    addressLine2: null,
    postalCode: '110 00',
    city: 'Praha',
    countryCode: 'CZ',
    companyId: '12345678',
    vatStatus: 'NOT_VAT_PAYER',
    vatId: null,
    registration: 'C 000000 vedená u testovacího soudu (syntetické)',
    email: 'fakturace@vystavitel.test',
    phone: null,
    web: null,
    ...over,
  });
  const czk = (over: Record<string, unknown> = {}) => ({
    label: 'Hlavní účet CZK (test)',
    currency: 'CZK',
    accountPrefix: '19',
    accountNumber: '2000145399',
    bankCode: '0800',
    iban: 'CZ65 0800 0000 1920 0014 5399',
    bic: 'GIBACZPX',
    ...over,
  });
  /** Another valid Czech account (same number at another bank). */
  const second = () =>
    czk({
      label: 'Druhý účet CZK (test)',
      accountPrefix: '000019',
      bankCode: '0100',
      iban: 'CZ0801000000192000145399',
    });
  const get = async () => (await f.get(I).expect(200)).body as IssuerSettings;
  const saveIssuer = (expectedVersion: number, over: Record<string, unknown> = {}) =>
    f.post(`${I}/versions`).send({
      requestId: randomUUID(),
      expectedVersion,
      issuer: issuer(over),
      reason: 'test',
    });
  const createAccount = (account: Record<string, unknown>) =>
    f
      .post(`${I}/bank-accounts`)
      .send({ requestId: randomUUID(), account, reason: 'Zřízení (test)' });
  const setDefault = (currency: string, accountCode: string, expectedRevision: number | null) =>
    f.post(`${I}/default-accounts`).send({
      requestId: randomUUID(),
      currency,
      accountCode,
      expectedRevision,
      reason: 'Volba výchozího účtu (test)',
    });
  const readiness = (s: IssuerSettings, currency: string) =>
    s.readiness.find((r) => r.currency === currency)?.gaps;

  beforeAll(async () => {
    f = await createFinanceTestApp();
  });
  afterAll(() => f?.close());

  it('nothing set yet: live issuing is blocked and says why', async () => {
    const s = await get();
    expect(s.current).toBeNull();
    expect(readiness(s, 'CZK')).toEqual(['ISSUER_MISSING', 'NO_DEFAULT_ACCOUNT']);
  });

  it('the issuer: versions with a reason; explicit VAT status; a stale form is refused, never written back', async () => {
    expect((await saveIssuer(0)).status).toBe(201);
    // A and B opened version 1. A sets the e-mail, B (stale) changes the phone: refused.
    expect((await saveIssuer(1, { email: 'nova@vystavitel.test' })).status).toBe(201);
    const stale = await saveIssuer(1, { phone: '+420 000 000 000' });
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    let s = await get();
    expect(s.current).toMatchObject({
      version: 2,
      issuer: { email: 'nova@vystavitel.test', phone: null },
    });
    expect(s.versions.map((v) => v.version)).toEqual([2, 1]);
    // VAT: explicit, a payer needs DIČ; nothing guessed.
    for (const bad of [{ vatStatus: undefined }, { vatStatus: 'VAT_PAYER' }, { companyId: '123' }])
      expect((await saveIssuer(2, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(
      (
        await saveIssuer(2, {
          vatStatus: 'VAT_PAYER',
          vatId: 'CZ12345678',
          email: 'nova@vystavitel.test',
        })
      ).status,
    ).toBe(201);
    // Three saves from the same version at once: exactly one.
    const raced = await Promise.all([0, 1, 2].map(() => saveIssuer(3)));
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    s = await get();
    expect(s.current!.version).toBe(4);
    expect(readiness(s, 'CZK')).toEqual(['NO_DEFAULT_ACCOUNT']);
  });

  it('bank accounts: IBAN and the Czech number are checked and must agree; a foreign account by IBAN', async () => {
    for (const bad of [
      czk({ iban: 'CZ65 0800 0000 1920 0014 5398' }),
      czk({ accountNumber: '2000145398' }),
      czk({ iban: 'CZ0801000000192000145399' }),
      czk({ bankCode: null }),
    ])
      expect((await createAccount(bad)).status, JSON.stringify(bad)).toBe(400);
    const s = (await createAccount(czk()).expect(201)).body as IssuerSettings;
    expect(s.accounts.at(-1)).toMatchObject({
      code: expect.stringMatching(/^IB-\d{6}$/),
      current: {
        version: 1,
        status: 'ACTIVE',
        account: { iban: 'CZ6508000000192000145399', accountPrefix: '19', bic: 'GIBACZPX' },
      },
    });
    await createAccount({
      label: 'EUR (test)',
      currency: 'EUR',
      accountPrefix: null,
      accountNumber: null,
      bankCode: null,
      iban: 'DE89370400440532013000',
      bic: null,
    }).expect(201);
  });

  it('one default account per currency: chosen with its revision; only an active account of that currency; the default is never retired silently', async () => {
    let s = await get();
    const main = s.accounts.find((a) => a.current.account.label === 'Hlavní účet CZK (test)')!;
    const eur = s.accounts.find((a) => a.current.account.currency === 'EUR')!;
    expect((await setDefault('CZK', eur.code, null)).body.code).toBe('ACCOUNT_NOT_USABLE');
    s = (await setDefault('CZK', main.code, null).expect(201)).body as IssuerSettings;
    expect(readiness(s, 'CZK')).toEqual([]);
    expect(readiness(s, 'EUR')).toEqual(['NO_DEFAULT_ACCOUNT']);
    const chosen = s.defaults.find((d) => d.currency === 'CZK')!;
    expect(chosen.accountCode).toBe(main.code);
    // A stale choice (form saw "none yet") is refused.
    expect((await setDefault('CZK', main.code, null)).body.code).toBe('CONCURRENT_CHANGE');
    // The default cannot be retired or moved to another currency before another is chosen.
    const retire = (
      code: string,
      version: number,
      account: Record<string, unknown>,
      status = 'RETIRED',
    ) =>
      f.post(`${I}/bank-accounts/${code}/versions`).send({
        requestId: randomUUID(),
        expectedVersion: version,
        status,
        account,
        reason: 'Účet zrušen (test)',
      });
    expect((await retire(main.code, 1, czk())).body.code).toBe('ACCOUNT_IS_DEFAULT');
    expect((await retire(main.code, 1, czk({ currency: 'EUR' }), 'ACTIVE')).body.code).toBe(
      'ACCOUNT_IS_DEFAULT',
    );
    const other = ((await createAccount(second()).expect(201)).body as IssuerSettings).accounts.at(
      -1,
    )!;
    s = (await setDefault('CZK', other.code, chosen.revision).expect(201)).body as IssuerSettings;
    s = (await retire(main.code, 1, czk()).expect(201)).body as IssuerSettings;
    const retired = s.accounts.find((a) => a.code === main.code)!;
    expect(retired.versions.map((v) => v.status)).toEqual(['RETIRED', 'ACTIVE']);
    expect(readiness(s, 'CZK')).toEqual([]);
    // A retired account cannot become the default.
    const current = s.defaults.find((d) => d.currency === 'CZK')!.revision;
    expect((await setDefault('CZK', main.code, current)).body.code).toBe('ACCOUNT_NOT_USABLE');
    // A stale account form is refused too.
    expect((await retire(main.code, 1, czk(), 'ACTIVE')).body.code).toBe('CONCURRENT_CHANGE');
  });

  it('append-only: no UPDATE/DELETE/TRUNCATE even for the owner; the runtime role cannot change rows', async () => {
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    try {
      for (const sql of [
        `UPDATE finance.issuer_versions SET email = 'x@y.test'`,
        'DELETE FROM finance.issuer_bank_account_versions',
        'UPDATE finance.issuer_default_accounts SET reason = $$x$$',
        'TRUNCATE finance.issuer_bank_accounts CASCADE',
      ])
        await expect(owner.$executeRawUnsafe(sql), sql).rejects.toThrow(/not allowed/);
      for (const sql of [
        `UPDATE finance.issuer_versions SET email = 'x@y.test'`,
        'DELETE FROM finance.issuer_default_accounts',
      ])
        await expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
    }
  });

  it('ADMIN only: another Finance role is refused reading and changing; ADMIN holds the permission', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const grants = await real.core.prisma.rolePermission.findMany({
        where: { permissionCode: 'finance:issuer_manage' },
        select: { roleCode: true },
      });
      expect(grants.map((g) => g.roleCode)).toEqual(['ADMIN']);
      const roleCode = `FINB_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Billing (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.createMany({
        data: ['finance:billing_read', 'finance:billing_manage', 'finance:documents_read'].map(
          (permissionCode) => ({ roleCode, permissionCode }),
        ),
      });
      const user = await prepareInvitedUser(real.core, {
        email: `issuer-${randomUUID()}@ayvo.test`,
        displayName: 'Bez nastavení firmy',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: no issuer settings' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(I, cookie).expect(403);
      await real
        .post(`${I}/versions`, cookie)
        .send({ requestId: randomUUID(), expectedVersion: 0, issuer: issuer(), reason: 'x' })
        .expect(403);
      await request(real.app.getHttpServer()).get(I).expect(401);
    } finally {
      await real.close();
    }
  });
});
