import { randomInt, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BankStatus, BankSyncResult, BankTransactionPage } from '@ayvo/types';
import { loadFinanceEnv } from '../src/finance/finance-env.js';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { FakeRb, type FakeEntry } from './support/fake-rb.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase } from './support/test-app.js';

/**
 * Bank transactions read from RB Premium API (N3B-1, doc 041) in the Finance unit, against a
 * SIMULATED bank over real mTLS (support/fake-rb.ts), a real core, real DB roles and synthetic
 * accounts only: exact amounts, pages, no duplicates on a repeated read, later changes as
 * versions, retries and failures (429 / 5xx / timeout / certificate / rights), all-or-nothing
 * storing, no overlapping runs, the append-only rules, permissions and no secret in any answer.
 */
const B = '/api/admin/finance/bank';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
const daysAgo = (n: number) => {
  const d = new Date(`${today}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
/** A synthetic account number, unique per test (the test files share one database). */
const accountNo = () => String(randomInt(1_000_000_000, 9_999_999_999));

describe.skipIf(!hasDatabase)('finance bank transactions (N3B-1, simulated RB Premium API)', () => {
  const bank = new FakeRb();
  const apps: FinanceTestApp[] = [];
  const appWith = async (env: Record<string, string>) => {
    const a = await createFinanceTestApp({ finance: env });
    apps.push(a);
    return a;
  };
  const sync = async (f: FinanceTestApp) =>
    (await f.post(`${B}/sync`).send({}).expect(200)).body as BankSyncResult;
  const list = async (f: FinanceTestApp, query = '') =>
    (await f.get(`${B}/transactions${query}`).expect(200)).body as BankTransactionPage;
  const entry = (over: Partial<FakeEntry> = {}): FakeEntry => ({
    entryReference: randomUUID(),
    amount: '100.00',
    creditDebitIndication: 'CRDT',
    bookingDate: `${today}T09:00:00.000+02:00`,
    ...over,
  });
  const owner = () =>
    new PrismaClient({ adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }) });

  beforeAll(async () => {
    await bank.start();
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    await bank.stop();
  });

  it('not configured: the status says so, a read is refused, nothing is listed or written', async () => {
    const f = await appWith({});
    const status = (await f.get(`${B}/status`).expect(200)).body as BankStatus;
    expect(status).toMatchObject({
      provider: 'RB_PREMIUM',
      environment: null,
      certificate: { state: 'NOT_CONFIGURED', notAfter: null },
      accounts: [],
    });
    const res = await f.post(`${B}/sync`).send({}).expect(409);
    expect(res.body.code).toBe('BANK_NOT_CONFIGURED');
  });

  it('reads all pages with exact amounts and symbols; a repeated read never duplicates; the window resumes with an overlap', async () => {
    const czk = accountNo();
    const eur = accountNo();
    bank.accounts.set(`${czk}/CZK`, [
      entry({
        amount: '1500.50',
        variable: '0012345',
        constant: '0308',
        message: 'Faktura 2026001 (syntetická)',
        counterParty: {
          name: 'Testovací hotel s.r.o.',
          accountNumberPrefix: '000019',
          accountNumber: '2000145399',
          bankCode: '0800',
          iban: 'CZ6508000000192000145399',
        },
      }),
      entry({
        amount: '-1668.59',
        creditDebitIndication: 'DBIT',
        bookingDate: `${daysAgo(3)}T10:00:00Z`,
      }),
      entry({ amount: '0.1', bookingDate: `${daysAgo(10)}T10:00:00Z` }),
      entry({ amount: '12345678901234567.89', bookingDate: `${daysAgo(20)}T10:00:00Z` }),
      entry({ amount: '7', bookingDate: `${daysAgo(88)}T10:00:00Z` }),
    ]);
    bank.accounts.set(`${eur}/EUR`, [entry({ amount: '61.00' })]);
    const f = await appWith(bank.env(`${czk}:CZK,${eur}:EUR`));
    const before = bank.requests.length;
    const first = await sync(f);
    expect(
      first.runs.map((r) => [r.accountNumber, r.status, r.pages, r.received, r.newCount]),
    ).toEqual([
      [czk, 'SUCCEEDED', 3, 5, 5],
      [eur, 'SUCCEEDED', 1, 1, 1],
    ]);
    // The documented request: client id header, 89 days back on the first read, pages 1..n.
    const sent = bank.requests.slice(before);
    expect(sent.every((r) => r.clientId === bank.clientId)).toBe(true);
    expect(sent[0]!.path).toBe(`/rbcz/premium/api/accounts/${czk}/CZK/transactions`);
    expect(Object.fromEntries(sent[0]!.query)).toEqual({ from: daysAgo(89), to: today, page: '1' });
    expect(sent.slice(0, 3).map((r) => r.query.get('page'))).toEqual(['1', '2', '3']);

    const page = await list(f, `?account=${czk}/CZK`);
    expect(page.total).toBe(5);
    expect(page.items.map((t) => t.amount)).toEqual([
      '1500.50',
      '-1668.59',
      '0.10',
      '12345678901234567.89',
      '7.00',
    ]);
    expect(page.items[0]).toMatchObject({
      environment: 'TEST',
      creditDebit: 'CRDT',
      amountCurrency: 'CZK',
      variableSymbol: '0012345',
      constantSymbol: '0308',
      message: 'Faktura 2026001 (syntetická)',
      counterparty: {
        name: 'Testovací hotel s.r.o.',
        account: '19-2000145399/0800',
        iban: 'CZ6508000000192000145399',
      },
      processing: 'NOT_PAIRED',
      version: 1,
    });
    expect(
      (await list(f, `?account=${czk}/CZK&direction=DBIT`)).items.map((t) => t.amount),
    ).toEqual(['-1668.59']);
    expect((await list(f, `?account=${czk}/CZK&from=${daysAgo(15)}`)).total).toBe(3);

    // Again: nothing new, nothing duplicated; the window starts 7 days before the last one ended.
    const at = bank.requests.length;
    const second = await sync(f);
    expect(second.runs.map((r) => [r.status, r.newCount, r.changedCount])).toEqual([
      ['SUCCEEDED', 0, 0],
      ['SUCCEEDED', 0, 0],
    ]);
    expect(bank.requests[at]!.query.get('from')).toBe(daysAgo(7));
    expect((await list(f, `?account=${czk}/CZK`)).total).toBe(5);

    const status = (await f.get(`${B}/status`).expect(200)).body as BankStatus;
    expect(status.environment).toBe('TEST');
    expect(status.certificate.state).toBe('READABLE');
    expect(Date.parse(status.certificate.notAfter!)).toBeGreaterThan(Date.now());
    expect(status.accounts.map((a) => [a.accountNumber, a.lastSuccess?.id])).toEqual([
      [czk, second.runs[0]!.id],
      [eur, second.runs[1]!.id],
    ]);
    // No secret value or secret file path in any answer.
    const answers = JSON.stringify([status, first, second, page]);
    for (const secret of [bank.clientId, bank.passphrase, bank.dir])
      expect(answers).not.toContain(secret);
  });

  it('the bank later sends different content for a known entry: a new version, the old one kept', async () => {
    const acc = accountNo();
    const e = entry({ amount: '250.00', message: 'Rezervace' });
    bank.accounts.set(`${acc}/CZK`, [e]);
    const f = await appWith(bank.env(`${acc}:CZK`));
    await sync(f);
    bank.accounts.set(`${acc}/CZK`, [{ ...e, message: 'Rezervace — doplněno bankou' }]);
    expect((await sync(f)).runs[0]).toMatchObject({ newCount: 0, changedCount: 1 });
    const [t] = (await list(f, `?account=${acc}/CZK`)).items;
    expect(t).toMatchObject({
      version: 2,
      message: 'Rezervace — doplněno bankou',
      amount: '250.00',
    });
    const db = owner();
    try {
      const versions = await db.bankTransactionVersion.findMany({
        where: { transactionId: t!.id },
        orderBy: { version: 'asc' },
        select: { version: true, message: true },
      });
      expect(versions).toEqual([
        { version: 1, message: 'Rezervace' },
        { version: 2, message: 'Rezervace — doplněno bankou' },
      ]);
    } finally {
      await db.$disconnect();
    }
  });

  it('retries 429 / 5xx / timeouts a bounded number of times; a lasting failure fails the run visibly and stores nothing', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry(), entry(), entry()]);
    const f = await appWith(bank.env(`${acc}:CZK`));
    bank.faults.push(503, 429);
    expect((await sync(f)).runs[0]).toMatchObject({ status: 'SUCCEEDED', newCount: 3 });

    const fresh = accountNo();
    bank.accounts.set(`${fresh}/CZK`, [entry(), entry(), entry()]);
    const g = await appWith(bank.env(`${fresh}:CZK`));
    const cases: [unknown[], string][] = [
      [[429, 429, 429], 'RATE_LIMITED'],
      [[500, 502, 503], 'BANK_UNAVAILABLE'],
      [['hang', 'hang', 'hang'], 'BANK_UNAVAILABLE'],
    ];
    for (const [faults, code] of cases) {
      bank.faults.push(...(faults as never[]));
      const [r] = (await sync(g)).runs;
      expect([r!.status, r!.errorCode, r!.newCount]).toEqual(['FAILED', code, null]);
      expect(r!.errorDetail).toBeTruthy();
    }
    expect(bank.faults).toEqual([]);
    // Page 1 is read, every attempt at page 2 fails: nothing of the window is stored.
    bank.failFromPage = 2;
    const [partial] = await sync(g)
      .then((r) => r.runs)
      .finally(() => (bank.failFromPage = null));
    expect([partial!.status, partial!.errorCode]).toEqual(['FAILED', 'BANK_UNAVAILABLE']);
    expect((await list(g, `?account=${fresh}/CZK`)).total).toBe(0);
    // The status shows the failure next to the last success (none here) — never hidden.
    const status = (await g.get(`${B}/status`).expect(200)).body as BankStatus;
    expect(status.accounts[0]).toMatchObject({
      lastRun: { status: 'FAILED', errorCode: 'BANK_UNAVAILABLE' },
      lastSuccess: null,
    });
  });

  it('certificate and rights: unreadable, refused by the bank, blocked, rights removed, unknown account', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry()]);
    const code = async (env: Record<string, string>) =>
      (await sync(await appWith(env))).runs[0]!.errorCode;
    const wrong = bank.env(`${acc}:CZK`, {
      RB_PREMIUM_P12_PASSPHRASE_FILE: bank.file('wrong-passphrase'),
    });
    expect(await code(wrong)).toBe('CERTIFICATE_UNUSABLE');
    const unreadable = await appWith(wrong);
    expect(
      ((await unreadable.get(`${B}/status`).expect(200)).body as BankStatus).certificate,
    ).toEqual({
      state: 'UNREADABLE',
      notAfter: null,
    });
    expect(
      await code(bank.env(`${acc}:CZK`, { RB_PREMIUM_P12_FILE: bank.file('foreign.p12') })),
    ).toBe('CERTIFICATE_REJECTED');
    bank.revoked = true;
    try {
      expect(await code(bank.env(`${acc}:CZK`))).toBe('CERTIFICATE_REJECTED');
    } finally {
      bank.revoked = false;
    }
    bank.forbidden.add(`${acc}/CZK`);
    try {
      expect(await code(bank.env(`${acc}:CZK`))).toBe('INSUFFICIENT_RIGHTS');
    } finally {
      bank.forbidden.delete(`${acc}/CZK`);
    }
    expect(await code(bank.env(`${accountNo()}:CZK`))).toBe('ACCOUNT_NOT_FOUND');
  });

  it('an answer outside the contract fails the run: more than 2 decimals is never rounded, non-JSON is refused', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry({ amount: '1.005' })]);
    const f = await appWith(bank.env(`${acc}:CZK`));
    expect((await sync(f)).runs[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'UNEXPECTED_RESPONSE',
    });
    bank.accounts.set(`${acc}/CZK`, [entry()]);
    bank.rawNext = '<html>maintenance</html>';
    expect((await sync(f)).runs[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'UNEXPECTED_RESPONSE',
    });
    expect((await list(f, `?account=${acc}/CZK`)).total).toBe(0);
    expect((await sync(f)).runs[0]).toMatchObject({ status: 'SUCCEEDED', newCount: 1 });
  });

  it('no overlapping runs: a second read while one runs is refused; a run left behind is finished as ABANDONED', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry()]);
    const f = await appWith(bank.env(`${acc}:CZK`, { RB_PREMIUM_TIMEOUT_MS: '3000' }));
    bank.faults.push('hang');
    const at = bank.requests.length;
    const slow = f.post(`${B}/sync`).send({});
    const running = slow.then((r) => r);
    await new Promise<void>((r) => {
      const check = () => (bank.requests.length > at ? r() : setImmediate(check));
      check();
    });
    const second = await f.post(`${B}/sync`).send({}).expect(409);
    expect(second.body.code).toBe('BANK_SYNC_RUNNING');
    expect(((await running).body as BankSyncResult).runs[0]!.status).toBe('SUCCEEDED');

    // A process that ended mid-run leaves its slot held; after the lease the next read takes over.
    const db = owner();
    try {
      const stale = await db.bankSyncRun.create({
        data: {
          provider: 'RB_PREMIUM',
          environment: 'TEST',
          accountNumber: acc,
          currency: 'CZK',
          fromDate: new Date(`${today}T00:00:00Z`),
          toDate: new Date(`${today}T00:00:00Z`),
          startedBy: randomUUID(),
          startedByName: 'Přerušený běh (test)',
        },
      });
      await db.bankSyncSlot.update({
        where: {
          environment_accountNumber_currency: {
            environment: 'TEST',
            accountNumber: acc,
            currency: 'CZK',
          },
        },
        data: { runningRunId: stale.id, claimedAt: new Date(Date.now() - 11 * 60_000) },
      });
      expect((await sync(f)).runs[0]!.status).toBe('SUCCEEDED');
      expect(await db.bankSyncRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
        status: 'FAILED',
        errorCode: 'ABANDONED',
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('memory bound (review N3B75-R1): pages each within limits but together over the window budget fail the run, nothing stored', async () => {
    const acc = accountNo();
    const long = 'Syntetická zpráva '.repeat(20);
    bank.accounts.set(
      `${acc}/CZK`,
      Array.from({ length: 6 }, () => entry({ message: long })),
    );
    const at = bank.responseBytes.length;
    const f = await appWith(bank.env(`${acc}:CZK`, { RB_PREMIUM_MAX_WINDOW_BYTES: '2048' }));
    const [r] = (await sync(f)).runs;
    expect([r!.status, r!.errorCode]).toEqual(['FAILED', 'TOO_MUCH_DATA']);
    const sent = bank.responseBytes.slice(at);
    // Several pages were each acceptable alone; their sum was not — refused before keeping it.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((b) => b < 2048)).toBe(true);
    expect(sent.reduce((a, b) => a + b, 0)).toBeGreaterThan(2048);
    expect((await list(f, `?account=${acc}/CZK`)).total).toBe(0);

    // The number of entries is bounded the same way.
    const g = await appWith(bank.env(`${acc}:CZK`, { RB_PREMIUM_MAX_WINDOW_ENTRIES: '3' }));
    expect((await sync(g)).runs[0]).toMatchObject({ status: 'FAILED', errorCode: 'TOO_MUCH_DATA' });
    expect((await list(g, `?account=${acc}/CZK`)).total).toBe(0);
    // Within the bounds the same window is read and stored normally.
    expect((await sync(await appWith(bank.env(`${acc}:CZK`)))).runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      newCount: 6,
    });
  });

  it('append-only: transactions and versions never change; a finished run never changes; the runtime role cannot delete', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry()]);
    const f = await appWith(bank.env(`${acc}:CZK`));
    const [r] = (await sync(f)).runs;
    const db = owner();
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    try {
      for (const sql of [
        `UPDATE finance.bank_transaction_versions SET amount = 1 WHERE run_id = '${r!.id}'`,
        `DELETE FROM finance.bank_transactions WHERE first_run_id = '${r!.id}'`,
        `UPDATE finance.bank_sync_runs SET new_count = 99 WHERE id = '${r!.id}'`,
        `DELETE FROM finance.bank_sync_runs WHERE id = '${r!.id}'`,
        'TRUNCATE finance.bank_transaction_versions',
      ])
        await expect(db.$executeRawUnsafe(sql), sql).rejects.toThrow(/not allowed|never/);
      for (const sql of [
        `UPDATE finance.bank_transaction_versions SET amount = 1 WHERE run_id = '${r!.id}'`,
        `DELETE FROM finance.bank_sync_runs WHERE id = '${r!.id}'`,
      ])
        await expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(
          /permission denied|never/,
        );
    } finally {
      await Promise.all([db.$disconnect(), runtime.$disconnect()]);
    }
  });

  it('permissions with real sessions: bank_read sees, only bank_sync reads from the bank; others are refused; ADMIN has both', async () => {
    const acc = accountNo();
    bank.accounts.set(`${acc}/CZK`, [entry()]);
    const real = await createFinanceTestApp({
      core: { auth: 'real' },
      finance: bank.env(`${acc}:CZK`),
    });
    apps.push(real);
    const grants = await real.core.prisma.rolePermission.findMany({
      where: { permissionCode: { startsWith: 'finance:bank' }, roleCode: 'ADMIN' },
      select: { permissionCode: true },
      orderBy: { permissionCode: 'asc' },
    });
    expect(grants.map((g) => g.permissionCode)).toEqual(['finance:bank_read', 'finance:bank_sync']);
    const roleCode = `BANKR_${randomUUID().slice(0, 8).toUpperCase()}`;
    await real.core.prisma.role.create({
      data: { code: roleCode, name: 'Bank read (test)', description: 'test' },
    });
    await real.core.prisma.rolePermission.create({
      data: { roleCode, permissionCode: 'finance:bank_read' },
    });
    const reader = await prepareInvitedUser(real.core, {
      email: `bank-read-${randomUUID()}@ayvo.test`,
      displayName: 'Jen čtení banky',
    });
    await real.core.prisma.userRole.create({
      data: { userId: reader.id, roleCode, grantReason: 'test: bank read' },
    });
    const readCookie = await sessionCookie(real.core, reader.email);
    await real.get(`${B}/status`, readCookie).expect(200);
    await real.get(`${B}/transactions`, readCookie).expect(200);
    const before = bank.requests.length;
    await real.post(`${B}/sync`, readCookie).send({}).expect(403);
    expect(bank.requests.length).toBe(before);

    const outsider = await prepareInvitedUser(real.core, {
      email: `bank-none-${randomUUID()}@ayvo.test`,
      displayName: 'Bez banky',
    });
    await real.core.prisma.userRole.create({
      data: { userId: outsider.id, roleCode: 'SALES', grantReason: 'test: no bank permission' },
    });
    const outCookie = await sessionCookie(real.core, outsider.email);
    for (const path of [`${B}/status`, `${B}/transactions`])
      expect([path, (await real.get(path, outCookie)).status]).toEqual([path, 403]);
    await real.post(`${B}/sync`, outCookie).send({}).expect(403);
  });

  it('configuration rules: production only in production, the simulation only in tests, all parts required; names only in errors', () => {
    const base = {
      FINANCE_DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
      CORE_INTERNAL_URL: 'http://api:4000',
      FINANCE_SERVICE_TOKEN: 'a'.repeat(43),
    };
    const files = {
      RB_PREMIUM_CLIENT_ID_FILE: '/run/secrets/rb-client-id',
      RB_PREMIUM_P12_FILE: '/run/secrets/rb.p12',
      RB_PREMIUM_P12_PASSPHRASE_FILE: '/run/secrets/rb-p12-pass',
      RB_PREMIUM_ACCOUNTS: '1234567890:CZK',
    };
    const fails = (env: Record<string, string>, name: string) =>
      expect(() => loadFinanceEnv({ ...base, ...env })).toThrow(name);
    fails(
      { APP_ENV: 'development', RB_PREMIUM_ENVIRONMENT: 'production', ...files },
      'RB_PREMIUM_ENVIRONMENT',
    );
    fails(
      { APP_ENV: 'development', RB_PREMIUM_ENVIRONMENT: 'test', ...files },
      'RB_PREMIUM_ENVIRONMENT',
    );
    fails(
      { APP_ENV: 'development', RB_PREMIUM_BASE_URL_FOR_TESTS: 'https://localhost:1/x' },
      'RB_PREMIUM_BASE_URL_FOR_TESTS',
    );
    fails({ APP_ENV: 'development', RB_PREMIUM_ENVIRONMENT: 'sandbox' }, 'RB_PREMIUM_P12_FILE');
    fails(
      {
        APP_ENV: 'development',
        RB_PREMIUM_ENVIRONMENT: 'sandbox',
        ...files,
        RB_PREMIUM_ACCOUNTS: '12-34/0800',
      },
      'RB_PREMIUM_ACCOUNTS',
    );
    expect(
      loadFinanceEnv({
        ...base,
        APP_ENV: 'development',
        RB_PREMIUM_ENVIRONMENT: 'sandbox',
        ...files,
      }).RB_PREMIUM_ENVIRONMENT,
    ).toBe('sandbox');
    try {
      loadFinanceEnv({
        ...base,
        APP_ENV: 'development',
        RB_PREMIUM_ENVIRONMENT: 'production',
        ...files,
      });
    } catch (e) {
      expect(String(e)).not.toContain('/run/secrets');
    }
  });
});
