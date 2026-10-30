import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EffectiveTermsPage,
  IncomingPayment,
  InvoiceDetail,
  InvoicesOverview,
  InvoiceSummary,
  IssuerSettings,
  PaymentLoadResult,
  PaymentsPage,
  TestRunPreview,
  TestRunResult,
} from '@ayvo/types';
import { BillingSettingsService } from '../src/finance/billing-settings.service.js';
import { FinanceOperations } from '../src/finance/finance-operations.js';
import { InvoicesService } from '../src/finance/invoices.service.js';
import { PaymentsService } from '../src/finance/payments.service.js';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { createHotel } from './support/order-fixtures.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';

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

  // --- TEST invoices (N3A-2b, doc 040 §9). Here, after the issuer and a CZK default account
  // exist: the issuer is one per installation and the tests above start from none.

  const B = '/api/admin/finance/billing';
  const INV = '/api/admin/finance/invoices';
  /** An active default CZK account (the tests above may leave the default retired). */
  const ensureCzkDefault = async () => {
    let s = await get();
    const d = s.defaults.find((x) => x.currency === 'CZK');
    const chosen = d && s.accounts.find((a) => a.code === d.accountCode);
    if (chosen?.current.status === 'ACTIVE') return;
    const fresh = ((await createAccount(czk()).expect(201)).body as IssuerSettings).accounts.at(
      -1,
    )!;
    s = (await setDefault('CZK', fresh.code, d?.revision ?? null).expect(201))
      .body as IssuerSettings;
  };
  const customer = async () =>
    (
      await f
        .post(`${B}/customers`)
        .send({
          requestId: randomUUID(),
          customer: {
            legalName: `Testovací hotely ${randomUUID().slice(0, 6)} s.r.o.`,
            companyId: '87654321',
            vatId: null,
            addressLine1: 'Hotelová 7',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@hotely.test',
          },
        })
        .expect(201)
    ).body as { id: string; code: string };
  const agreement = async (customerId: string, over: Record<string, unknown> = {}) => {
    const h = await createHotel(f.core);
    const { id } = await f.core.prisma.hotel.findUniqueOrThrow({
      where: { code: h.code },
      select: { id: true },
    });
    return (
      await f
        .post(`${B}/agreements`)
        .send({
          requestId: randomUUID(),
          hotelId: id,
          terms: {
            effectiveFrom: '2026-01',
            customerId,
            contractNumber: null,
            billedRooms: 12,
            ownPricePerRoomMonth: '350.00',
            currency: 'CZK',
            paymentTermsDays: 14,
            billingTiming: 'ARREARS',
            validFrom: '2026-01-01',
            validTo: null,
            reason: 'Smlouva (syntetická)',
            ...over,
          },
        })
        .expect(201)
    ).body as { code: string; hotel: { code: string; name: string } };
  };
  /** The terms of a month as the issuing form loads them (its preview). */
  const preview = async (month: string) =>
    (
      (await f.get(`${B}/agreements/effective?month=${month}`).expect(200))
        .body as EffectiveTermsPage
    ).items;
  /** The lines the form sends: exactly what the preview showed (BILL86-R1). */
  const linesOf = (items: EffectiveTermsPage['items'], codes: string[]) =>
    codes.map((code) => {
      const i = items.find((x) => x.agreement.code === code);
      return {
        agreementCode: code,
        agreementRevision: i?.version?.revision ?? 1,
        customerVersion: i?.customer?.version ?? 1,
        priceListVersionId: i?.price.priceListVersionId ?? null,
        unitPrice: i?.price.perRoomMonth ?? '0.00',
        billedRooms: i?.version?.billedRooms ?? 1,
      };
    });
  const issueLines = (
    lines: ReturnType<typeof linesOf>,
    month = '2026-09',
    requestId = randomUUID(),
  ) => f.post(`${INV}/test`).send({ requestId, month, lines });
  /** Issues from a freshly loaded preview (what a user clicking "Vystavit" does). */
  const issue = async (agreementCodes: string[], month = '2026-09', requestId = randomUUID()) =>
    issueLines(linesOf(await preview(month), agreementCodes), month, requestId);
  const expectStatus = async (r: Promise<request.Response> | request.Test, status: number) => {
    const res = await r;
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res;
  };

  it('a separate TEST invoice: rooms × price, frozen snapshot, PDF with QR stored by hash; issued once', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const a = await agreement(c.id);
    const requestId = randomUUID();
    const res = await issue([a.code], '2026-09', requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const inv = res.body as InvoiceDetail;
    const year = inv.issuedOn.slice(0, 4);
    expect(inv.number).toMatch(new RegExp(`^T${year}-\\d{5}$`));
    expect(inv.variableSymbol).toBe(`99${year}${inv.number.slice(-4)}`);
    expect(inv).toMatchObject({
      kind: 'TEST',
      status: 'VALID',
      period: '2026-09',
      currency: 'CZK',
      total: '4200.00',
      customer: { code: c.code },
      hotels: [{ code: a.hotel.code, name: a.hotel.name }],
      lines: [
        {
          lineNo: 1,
          agreementCode: a.code,
          billedRooms: 12,
          unitPrice: '350.00',
          amount: '4200.00',
        },
      ],
      payment: {
        amount: '4200.00',
        currency: 'CZK',
        variableSymbol: inv.variableSymbol,
        dueOn: inv.dueOn,
      },
    });
    const due = new Date(`${inv.issuedOn}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 14);
    expect(inv.dueOn).toBe(due.toISOString().slice(0, 10));
    // The PDF exactly as stored: a PDF whose hash is the one recorded.
    const pdf = await f
      .get(`${INV}/${inv.number}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (d: Buffer) => parts.push(d));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(inv.pdfSha256);
    // Repeated: the same invoice; another payload with the same id: refused.
    expect(
      ((await expectStatus(issue([a.code], '2026-09', requestId), 201)).body as InvoiceDetail)
        .number,
    ).toBe(inv.number);
    expect((await issue([a.code], '2026-10', requestId)).body.code).toBe('IDEMPOTENCY_CONFLICT');
    // A second valid invoice for the same agreement and month: refused.
    const again = await issue([a.code]);
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    // Cancelled with a reason (a separate record): then the month may be invoiced again.
    const cancelled = (
      await f
        .post(`${INV}/${inv.number}/cancel`)
        .send({ requestId: randomUUID(), reason: 'Chybný počet pokojů (test)' })
        .expect(200)
    ).body as InvoiceDetail;
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancellation: { reason: 'Chybný počet pokojů (test)' },
    });
    expect(
      (
        await f
          .post(`${INV}/${inv.number}/cancel`)
          .send({ requestId: randomUUID(), reason: 'znovu' })
      ).body.code,
    ).toBe('ALREADY_CANCELLED');
    const next = (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
    expect(next.number).not.toBe(inv.number);
    const list = (await f.get(INV).expect(200)).body as InvoiceSummary[];
    expect(list.filter((i) => i.hotels[0]?.code === a.hotel.code).map((i) => i.status)).toEqual([
      'VALID',
      'CANCELLED',
    ]);
  });

  it('a summary TEST invoice of one customer: a line per hotel, exact sum; never two customers, currencies or terms', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const h1 = await agreement(c.id, { billedRooms: 10, ownPricePerRoomMonth: '300.00' });
    const h2 = await agreement(c.id, { billedRooms: 5, ownPricePerRoomMonth: '1234.56' });
    const inv = (await expectStatus(issue([h1.code, h2.code]), 201)).body as InvoiceDetail;
    expect(inv.lines.map((l) => [l.agreementCode, l.amount])).toEqual([
      [h1.code, '3000.00'],
      [h2.code, '6172.80'],
    ]);
    expect([inv.total, inv.hotels.length]).toEqual(['9172.80', 2]);

    const other = await customer();
    const foreign = await agreement(other.id);
    const eur = await agreement(c.id, { currency: 'EUR', ownPricePerRoomMonth: '20.00' });
    const longer = await agreement(c.id, { paymentTermsDays: 30 });
    const partial = await agreement(c.id, { validFrom: '2026-09-15' });
    const noPrice = await agreement(c.id, { currency: 'XQZ', ownPricePerRoomMonth: null });
    const fresh = await agreement(c.id);
    for (const [codes, code] of [
      [[fresh.code, foreign.code], 'CUSTOMERS_DIFFER'],
      [[fresh.code, eur.code], 'CURRENCIES_DIFFER'],
      [[fresh.code, longer.code], 'PAYMENT_TERMS_DIFFER'],
      [[partial.code], 'TERMS_INCOMPLETE'],
      [[noPrice.code], 'TERMS_INCOMPLETE'],
      [['BA-999999'], 'AGREEMENT_NOT_FOUND'],
    ] as const) {
      const res = await issue([...codes]);
      expect([codes.join('+'), res.status, res.body.code]).toEqual([codes.join('+'), 422, code]);
    }
    // Nothing was written by a refusal: the fresh agreement can still be invoiced once.
    await expectStatus(issue([fresh.code]), 201);
  });

  it('a summary follows the payer of the month: a hotel handed over to another company is never billed to the first', async () => {
    await ensureCzkDefault();
    const first = await customer();
    const second = await customer();
    const stays = await agreement(first.id);
    const moves = await agreement(first.id);
    // From October the second hotel is paid by another company (a new version of its terms).
    const detail = (await f.get(`${B}/agreements/${moves.code}`).expect(200)).body as {
      versions: { revision: number }[];
    };
    await f
      .post(`${B}/agreements/${moves.code}/versions`)
      .send({
        requestId: randomUUID(),
        expectedRevision: detail.versions[0]!.revision,
        terms: {
          effectiveFrom: '2026-10',
          customerId: second.id,
          contractNumber: null,
          billedRooms: 12,
          ownPricePerRoomMonth: '350.00',
          currency: 'CZK',
          paymentTermsDays: 14,
          billingTiming: 'ARREARS',
          validFrom: '2026-01-01',
          validTo: null,
          reason: 'Hotel převzala jiná firma (syntetické)',
        },
      })
      .expect(201);
    // September: both hotels still belong to the first company.
    const september = (await expectStatus(issue([stays.code, moves.code], '2026-09'), 201))
      .body as InvoiceDetail;
    expect([september.customer.code, september.lines.length]).toEqual([first.code, 2]);
    // October: the moved hotel cannot join the first company's summary...
    const refused = await issue([stays.code, moves.code], '2026-10');
    expect([refused.status, refused.body.code]).toEqual([422, 'CUSTOMERS_DIFFER']);
    // ...and alone it is billed to its new payer.
    const october = (await expectStatus(issue([moves.code], '2026-10'), 201)).body as InvoiceDetail;
    expect(october.customer.code).toBe(second.code);
  });

  /** A new version of an agreement's terms (as a second user would save it). */
  const changeTerms = async (code: string, over: Record<string, unknown>) => {
    const d = (await f.get(`${B}/agreements/${code}`).expect(200)).body as {
      versions: { revision: number; customer: { id: string } }[];
    };
    await f
      .post(`${B}/agreements/${code}/versions`)
      .send({
        requestId: randomUUID(),
        expectedRevision: d.versions[0]!.revision,
        terms: {
          effectiveFrom: '2026-01',
          customerId: d.versions[0]!.customer.id,
          contractNumber: null,
          billedRooms: 12,
          ownPricePerRoomMonth: '350.00',
          currency: 'CZK',
          paymentTermsDays: 14,
          billingTiming: 'ARREARS',
          validFrom: '2026-01-01',
          validTo: null,
          reason: 'Změna podmínek (test)',
          ...over,
        },
      })
      .expect(201);
  };

  it('BILL86-R1: issuing is bound to the terms the user saw — a change since is 409, nothing issued', async () => {
    if (!(await get()).current) await saveIssuer(0).expect(201);
    await ensureCzkDefault();
    const c = await customer();
    const a = await agreement(c.id);
    const seen = linesOf(await preview('2026-09'), [a.code]); // 12 × 350.00 = 4200.00 shown
    await changeTerms(a.code, { ownPricePerRoomMonth: '999.00' });
    const stale = await issueLines(seen);
    expect([stale.status, stale.body.code]).toEqual([409, 'TERMS_CHANGED']);
    expect(
      (await f.get(INV).expect(200)).body.filter((i: InvoiceSummary) =>
        i.hotels.some((h) => h.code === a.hotel.code),
      ),
    ).toEqual([]);
    // The customer's details changed since the preview: refused as well.
    const fresh = linesOf(await preview('2026-09'), [a.code]);
    await f
      .post(`${B}/customers/${c.code}/versions`)
      .send({
        requestId: randomUUID(),
        expectedVersion: 1,
        customer: {
          legalName: 'Přejmenovaná firma s.r.o.',
          companyId: '87654321',
          vatId: null,
          addressLine1: 'Hotelová 7',
          addressLine2: null,
          postalCode: '602 00',
          city: 'Brno',
          countryCode: 'CZ',
          billingEmail: 'fakturace@hotely.test',
        },
        reason: 'Změna názvu (test)',
      })
      .expect(201);
    expect((await issueLines(fresh)).body.code).toBe('TERMS_CHANGED');
    // Loaded again, the user sees and confirms the new amount.
    const now = (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
    expect([now.total, now.customer.legalName]).toEqual(['11988.00', 'Přejmenovaná firma s.r.o.']);
  });

  it('BILL86-R1: terms changed between the check and the save are never issued (the issue waits for the writer)', async () => {
    if (!(await get()).current) await saveIssuer(0).expect(201);
    await ensureCzkDefault();
    const a = await agreement((await customer()).id);
    const seen = linesOf(await preview('2026-09'), [a.code]);
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      let issuing: Promise<request.Response> | null = null;
      // A writer holds the terms' lock (as saving a version does) and commits a new price only
      // after the issue request has started.
      await owner.$transaction(async (tx) => {
        const [{ v }] = await tx.$queryRaw<[{ v: bigint }]>`
          UPDATE finance.code_counters SET last_value = last_value + 1
          WHERE name = 'billing_revision' RETURNING last_value AS v`;
        await tx.$executeRaw`
          INSERT INTO finance.agreement_versions (revision, agreement_id, effective_from, customer_id,
            contract_number, billed_rooms, own_price_per_room_month, currency, payment_terms_days,
            billing_timing, valid_from, valid_to, reason, recorded_by, recorded_by_name, request_id)
          SELECT ${v}, agreement_id, effective_from, customer_id, contract_number, billed_rooms,
            999.00, currency, payment_terms_days, billing_timing, valid_from, valid_to,
            'Souběžná změna (test)', recorded_by, recorded_by_name, gen_random_uuid()
          FROM finance.agreement_versions
          WHERE revision = ${seen[0]!.agreementRevision}`;
        issuing = issueLines(seen).then((r) => r);
        await new Promise((r) => setTimeout(r, 500)); // the request reaches the lock and waits
      });
      const res = await issuing!;
      expect([res.status, res.body.code]).toEqual([409, 'TERMS_CHANGED']);
    } finally {
      await owner.$disconnect();
    }
  });

  it('BILL86-R2: a repeated request returns the issued invoice even after its terms ended', async () => {
    if (!(await get()).current) await saveIssuer(0).expect(201);
    await ensureCzkDefault();
    const a = await agreement((await customer()).id);
    const requestId = randomUUID();
    const lines = linesOf(await preview('2026-09'), [a.code]);
    const first = (await expectStatus(issueLines(lines, '2026-09', requestId), 201))
      .body as InvoiceDetail;
    await changeTerms(a.code, { validTo: '2026-08-31' }); // September no longer in effect
    const again = await expectStatus(issueLines(lines, '2026-09', requestId), 201);
    expect((again.body as InvoiceDetail).number).toBe(first.number);
  });

  it('BILL86-R3: an issued invoice never gains a line — not even through the runtime role', async () => {
    if (!(await get()).current) await saveIssuer(0).expect(201);
    await ensureCzkDefault();
    const c = await customer();
    const a = await agreement(c.id);
    const other = await agreement(c.id);
    const inv = (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
    const row = await f.prisma.invoice.findUniqueOrThrow({
      where: { number: inv.number },
      include: { lines: true },
    });
    const line = row.lines[0]!;
    // The same hotel again, or another agreement at a price of 0.00: both refused after issuing.
    await expect(f.prisma.invoiceLine.create({ data: { ...line, lineNo: 2 } })).rejects.toThrow(
      /gains no line|Unique constraint/,
    );
    const otherTerms = (await preview('2026-09')).find((i) => i.agreement.code === other.code)!;
    await expect(
      f.prisma.invoiceLine.create({
        data: {
          ...line,
          lineNo: 2,
          agreementId: otherTerms.agreement.id,
          agreementRevision: BigInt(otherTerms.version!.revision),
          unitPrice: '0.00',
          amount: '0.00',
        },
      }),
    ).rejects.toThrow(/gains no line/);
    const detail = (await f.get(`${INV}/${inv.number}`).expect(200)).body as InvoiceDetail;
    expect([detail.total, detail.lines.map((l) => l.amount)]).toEqual(['4200.00', ['4200.00']]);
  });

  it('TEST invoices: append-only, only kind TEST, exact sums and one valid invoice per agreement and month — in the database', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const a = await agreement(c.id);
    const inv = (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      const row = await owner.invoice.findUniqueOrThrow({
        where: { number: inv.number },
        include: { lines: true },
      });
      for (const sql of [
        `UPDATE finance.invoices SET total = 1 WHERE id = '${row.id}'`,
        `DELETE FROM finance.invoices WHERE id = '${row.id}'`,
        `UPDATE finance.invoice_lines SET amount = 1 WHERE invoice_id = '${row.id}'`,
      ])
        await expect(owner.$executeRawUnsafe(sql), sql).rejects.toThrow();
      const copy = (over: Record<string, unknown>) => ({
        serial: row.serial + 100000n,
        kind: 'TEST',
        number: `T2099-${String((Number(row.serial) % 90000) + 10000)}`,
        variableSymbol: `98${String(row.serial).padStart(8, '0')}`,
        customerId: row.customerId,
        customerVersion: row.customerVersion,
        periodMonth: row.periodMonth,
        issuedOn: row.issuedOn,
        dueOn: row.dueOn,
        currency: row.currency,
        total: row.total,
        snapshot: {},
        pdfStorageKey: `finance-documents/2099/01/${randomUUID()}.pdf`,
        pdfSha256: '0'.repeat(64),
        issuedBy: randomUUID(),
        issuedByName: 'x',
        requestId: randomUUID(),
        ...over,
      });
      const line = (over: Record<string, unknown> = {}) => {
        const l = row.lines[0]!;
        return {
          lineNo: 1,
          agreementId: l.agreementId,
          agreementRevision: l.agreementRevision,
          periodMonth: l.periodMonth,
          hotelId: l.hotelId,
          hotelCode: l.hotelCode,
          hotelName: l.hotelName,
          billedRooms: l.billedRooms,
          unitPrice: l.unitPrice,
          amount: l.amount,
          ...over,
        };
      };
      // Only TEST exists.
      await expect(
        owner.invoice.create({ data: { ...copy({ kind: 'LIVE' }), lines: { create: [line()] } } }),
      ).rejects.toThrow();
      // A second valid invoice of the same agreement and month.
      await expect(
        owner.invoice.create({ data: { ...copy({}), lines: { create: [line()] } } }),
      ).rejects.toThrow(/already has a valid invoice/);
      // A line that is not rooms × price; a total that is not the sum; an invoice without lines.
      const later = new Date('2030-01-01T00:00:00Z');
      await expect(
        owner.invoice.create({
          data: {
            ...copy({ periodMonth: later }),
            lines: { create: [line({ periodMonth: later, amount: '1.00' })] },
          },
        }),
      ).rejects.toThrow();
      await expect(
        owner.invoice.create({
          data: {
            ...copy({ periodMonth: later, total: '1.00' }),
            lines: { create: [line({ periodMonth: later })] },
          },
        }),
      ).rejects.toThrow(/sum is its total/);
      await expect(owner.invoice.create({ data: copy({ periodMonth: later }) })).rejects.toThrow(
        /sum is its total/,
      );
    } finally {
      await owner.$disconnect();
    }
  });

  it('TEST invoices: never in production; ADMIN only', async () => {
    const prod = new InvoicesService(
      f.prisma,
      f.app.get(FinanceOperations),
      f.app.get(BillingSettingsService),
      f.storage,
      { ...f.env, APP_ENV: 'production' },
    );
    await expect(
      prod.issueTest(
        { requestId: randomUUID(), month: '2026-09', lines: linesOf([], ['BA-000001']) },
        {
          principal: { userId: randomUUID(), displayName: 'x' },
          sessionToken: 'x',
        } as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'TEST_INVOICES_DISABLED' } });
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      for (const code of ['finance:invoices_read', 'finance:invoices_test']) {
        const grants = await real.core.prisma.rolePermission.findMany({
          where: { permissionCode: code },
          select: { roleCode: true },
        });
        expect([code, grants.map((g) => g.roleCode)]).toEqual([code, ['ADMIN']]);
      }
      const roleCode = `FINI_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Billing (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.createMany({
        data: ['finance:billing_read', 'finance:billing_manage'].map((permissionCode) => ({
          roleCode,
          permissionCode,
        })),
      });
      const user = await prepareInvitedUser(real.core, {
        email: `invoices-${randomUUID()}@ayvo.test`,
        displayName: 'Bez faktur',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: no invoices' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(INV, cookie).expect(403);
      await real
        .post(`${INV}/test`, cookie)
        .send({ requestId: randomUUID(), month: '2026-09', lines: linesOf([], ['BA-000001']) })
        .expect(403);
    } finally {
      await real.close();
    }
  });

  // --- Incoming payments and the payment state (N3B-2, doc 041 §8): after the invoices above.

  const PAY = '/api/admin/finance/payments';
  const simulate = (entries: Record<string, unknown>[], requestId = randomUUID()) =>
    f.post(`${PAY}/simulate`).send({
      requestId,
      entries: entries.map((e) => ({
        currency: 'CZK',
        bookedOn: '2026-10-20',
        variableSymbol: null,
        counterpartyName: 'Testovací hotely s.r.o.',
        message: null,
        ...e,
      })),
    });
  const payments = async () => (await f.get(PAY).expect(200)).body as PaymentsPage;
  const payment = async (reference: string) =>
    (await payments()).payments.find((p) => p.reference === reference)!;
  const invoiceOf = async (number: string) =>
    (await f.get(`${INV}/${number}`).expect(200)).body as InvoiceDetail;
  const ref = (tag: string) => `SIM-${tag}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const freshInvoice = async () => {
    const c = await customer();
    const a = await agreement(c.id); // 12 × 350.00 = 4200.00
    return (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
  };

  it('payments: partial, unclear and repeated — matched only on the exact VS, never counted twice', async () => {
    await ensureCzkDefault();
    const inv = await freshInvoice();
    const [partial, noVs, unknownVs] = [ref('A'), ref('B'), ref('C')];
    const statement = [
      { reference: partial, amount: '1000.00', variableSymbol: inv.variableSymbol },
      { reference: noVs, amount: '500.00', message: 'Platba za pokoje' },
      { reference: unknownVs, amount: '3200.00', variableSymbol: '1234' },
    ];
    const first = (await simulate(statement).expect(200)).body as PaymentLoadResult;
    expect([first.created.length, first.alreadyLoaded, first.matched, first.toReview]).toEqual([
      3, 0, 1, 2,
    ]);
    expect((await invoiceOf(inv.number)).paymentState).toMatchObject({
      state: 'PARTIALLY_PAID',
      paid: '1000.00',
      remaining: '3200.00',
    });
    // The same statement loaded again (a new request): nothing recorded, nothing counted twice.
    const again = (await simulate(statement).expect(200)).body as PaymentLoadResult;
    expect([again.created, again.alreadyLoaded]).toEqual([[], 3]);
    expect((await invoiceOf(inv.number)).paymentState.paid).toBe('1000.00');
    expect(await payment(partial)).toMatchObject({
      matchResult: 'MATCHED',
      state: 'ALLOCATED',
      allocations: [{ invoiceNumber: inv.number, amount: '1000.00', kind: 'AUTO', reason: null }],
    });
    // Unclear: no VS / an unknown VS — waiting for a person with the reason; the unknown-VS
    // payment equals the invoice's remaining amount: a suggestion, never applied by itself.
    expect(await payment(noVs)).toMatchObject({
      matchResult: 'NO_VARIABLE_SYMBOL',
      state: 'UNALLOCATED',
      allocations: [],
    });
    const unclear = await payment(unknownVs);
    expect(unclear).toMatchObject({ matchResult: 'UNKNOWN_VARIABLE_SYMBOL', state: 'UNALLOCATED' });
    expect(unclear.suggestions).toContain(inv.number);
    // A person allocates it with a reason: the invoice is paid.
    const allocated = (
      await f
        .post(`${PAY}/${unclear.code}/allocations`)
        .send({
          requestId: randomUUID(),
          invoiceNumber: inv.number,
          amount: '3200.00',
          reason: 'Hotel uvedl špatný VS (ověřeno telefonicky)',
        })
        .expect(200)
    ).body as IncomingPayment;
    expect(allocated).toMatchObject({ state: 'ALLOCATED', allocations: [{ kind: 'MANUAL' }] });
    const paid = await invoiceOf(inv.number);
    expect(paid.paymentState).toMatchObject({ state: 'PAID', paid: '4200.00', remaining: '0.00' });
    expect(paid.allocations.map((a) => [a.paymentCode, a.amount, a.kind])).toEqual([
      [(await payment(partial)).code, '1000.00', 'AUTO'],
      [unclear.code, '3200.00', 'MANUAL'],
    ]);
    // More than the invoice still needs: refused, nothing written.
    const over = await f.post(`${PAY}/${(await payment(noVs)).code}/allocations`).send({
      requestId: randomUUID(),
      invoiceNumber: inv.number,
      amount: '500.00',
      reason: 'pokus o přeplacení',
    });
    expect([over.status, over.body.code]).toEqual([422, 'EXCEEDS_INVOICE']);
    // A paid invoice is not cancelled; a later payment with its VS is "already paid".
    const cancel = await f
      .post(`${INV}/${inv.number}/cancel`)
      .send({ requestId: randomUUID(), reason: 'nelze' });
    expect([cancel.status, cancel.body.code]).toEqual([409, 'INVOICE_HAS_PAYMENTS']);
    const late = ref('G');
    await simulate([
      { reference: late, amount: '100.00', variableSymbol: inv.variableSymbol },
    ]).expect(200);
    expect((await payment(late)).matchResult).toBe('INVOICE_ALREADY_PAID');
  });

  it('payments: an overpayment keeps its rest; another currency or a cancelled invoice is never matched', async () => {
    await ensureCzkDefault();
    const inv = await freshInvoice();
    const cancelled = await freshInvoice();
    await f
      .post(`${INV}/${cancelled.number}/cancel`)
      .send({ requestId: randomUUID(), reason: 'Zrušeno (test)' })
      .expect(200);
    const [over, eur, gone] = [ref('D'), ref('E'), ref('F')];
    await simulate([
      { reference: over, amount: '5000.00', variableSymbol: inv.variableSymbol },
      { reference: eur, amount: '170.00', currency: 'EUR', variableSymbol: inv.variableSymbol },
      { reference: gone, amount: '4200.00', variableSymbol: cancelled.variableSymbol },
    ]).expect(200);
    expect(await payment(over)).toMatchObject({
      matchResult: 'PARTIAL_OVERPAYMENT',
      state: 'PARTIALLY_ALLOCATED',
      allocated: '4200.00',
      unallocated: '800.00',
    });
    expect((await invoiceOf(inv.number)).paymentState.state).toBe('PAID');
    expect((await payment(eur)).matchResult).toBe('CURRENCY_MISMATCH');
    expect((await payment(gone)).matchResult).toBe('INVOICE_CANCELLED');
    expect((await invoiceOf(cancelled.number)).paymentState.paid).toBe('0.00');
  });

  it('payments from read bank transactions: recorded once each; a production payment never pays a TEST invoice', async () => {
    await ensureCzkDefault();
    const inv = await freshInvoice();
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    const account = String(Date.now()).slice(-10);
    try {
      const transaction = async (environment: string, amount: string, vs: string) => {
        const run = await owner.bankSyncRun.create({
          data: {
            provider: 'RB_PREMIUM',
            environment,
            accountNumber: account,
            currency: 'CZK',
            fromDate: new Date('2026-10-01'),
            toDate: new Date('2026-10-27'),
            startedBy: randomUUID(),
            startedByName: 'test',
          },
        });
        const t = await owner.bankTransaction.create({
          data: {
            environment,
            accountNumber: account,
            currency: 'CZK',
            entryReference: randomUUID(),
            firstRunId: run.id,
          },
        });
        await owner.bankTransactionVersion.create({
          data: {
            transactionId: t.id,
            version: 1,
            runId: run.id,
            contentSha256: 'a'.repeat(64),
            amount,
            amountCurrency: 'CZK',
            creditDebit: 'CRDT',
            bookingDate: new Date('2026-10-21T09:00:00Z'),
            bankTransactionCode: 'PMNT',
            variableSymbol: vs,
            counterpartyName: 'Testovací hotely s.r.o.',
            raw: '{}',
          },
        });
        return t.id;
      };
      const testTx = await transaction('TEST', '4200.00', `00${inv.variableSymbol}`.slice(-10));
      const prodTx = await transaction('PRODUCTION', '4200.00', inv.variableSymbol);
      const first = (
        await f.post(`${PAY}/import-bank`).send({ requestId: randomUUID() }).expect(200)
      ).body as PaymentLoadResult;
      expect(first.created.length).toBeGreaterThanOrEqual(2);
      const again = (
        await f.post(`${PAY}/import-bank`).send({ requestId: randomUUID() }).expect(200)
      ).body as PaymentLoadResult;
      expect(again.created).toEqual([]);
      const byTx = async (id: string) =>
        (await payments()).payments.find((p) => p.reference === id)!;
      expect(await byTx(testTx)).toMatchObject({
        source: 'BANK',
        environment: 'TEST',
        matchResult: 'MATCHED',
        state: 'ALLOCATED',
      });
      expect(await byTx(prodTx)).toMatchObject({
        environment: 'PRODUCTION',
        matchResult: 'ENVIRONMENT_MISMATCH',
        state: 'UNALLOCATED',
      });
      expect((await invoiceOf(inv.number)).paymentState.state).toBe('PAID');
      // A person may not allocate the production payment to the TEST invoice either.
      const target = await freshInvoice();
      const prodCode = (await byTx(prodTx)).code;
      const manual = await f.post(`${PAY}/${prodCode}/allocations`).send({
        requestId: randomUUID(),
        invoiceNumber: target.number,
        amount: '1.00',
        reason: 'pokus o spojení ostré platby s testovací fakturou',
      });
      expect([manual.status, manual.body.code]).toEqual([422, 'ENVIRONMENT_MISMATCH']);
      // The bank changes the recorded transaction later (a new version): nothing recorded or
      // allocated is overwritten — it is reported and flagged for a person (also on the Finance
      // overview, although the payment is fully allocated: review FIN90-R1).
      const overviewNow = async () =>
        (await f.get(`${INV}/overview`).expect(200)).body as InvoicesOverview;
      const before = await overviewNow();
      const v1 = await owner.bankTransactionVersion.findFirstOrThrow({
        where: { transactionId: testTx, version: 1 },
      });
      await owner.bankTransactionVersion.create({
        data: {
          ...v1,
          version: 2,
          amount: '1.00',
          contentSha256: 'b'.repeat(64),
          recordedAt: undefined,
        },
      });
      const changed = (
        await f.post(`${PAY}/import-bank`).send({ requestId: randomUUID() }).expect(200)
      ).body as PaymentLoadResult;
      expect([changed.created, changed.changedAtBank]).toEqual([[], 1]);
      expect(await byTx(testTx)).toMatchObject({
        amount: '4200.00',
        allocated: '4200.00',
        bankChangedSinceRecorded: true,
      });
      expect((await invoiceOf(inv.number)).paymentState).toMatchObject({
        state: 'PAID',
        paid: '4200.00',
      });
      expect((await byTx(prodTx)).bankChangedSinceRecorded).toBe(false);
      // Counted apart from the unallocated ones (it is fully allocated): never lost (FIN90-R1).
      const after = await overviewNow();
      expect(after.paymentsChangedAtBank).toBe(before.paymentsChangedAtBank + 1);
      expect(after.paymentsToReview).toBe(before.paymentsToReview);
      // The database refuses what the API refuses: a production payment for a TEST invoice, more
      // than the payment or the invoice, a change of a payment.
      const prod = await owner.incomingPayment.findFirstOrThrow({ where: { sourceKey: prodTx } });
      const invRow = await owner.invoice.findUniqueOrThrow({ where: { number: inv.number } });
      const alloc = (paymentId: string, invoiceId: string, amount: string) =>
        owner.paymentAllocation.create({
          data: {
            paymentId,
            invoiceId,
            amount,
            kind: 'AUTO',
            recordedBy: randomUUID(),
            recordedByName: 'x',
          },
        });
      await expect(alloc(prod.id, invRow.id, '1.00')).rejects.toThrow(/no production payment/);
      const other = await freshInvoice();
      const otherRow = await owner.invoice.findUniqueOrThrow({ where: { number: other.number } });
      const testPay = await owner.incomingPayment.findFirstOrThrow({
        where: { sourceKey: testTx },
      });
      await expect(alloc(testPay.id, otherRow.id, '1.00')).rejects.toThrow(
        /never exceed the payment/,
      );
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE finance.incoming_payments SET amount = 1 WHERE id = '${prod.id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        owner.incomingPayment.create({
          data: {
            ...prod,
            id: undefined,
            serial: prod.serial + 1000000n,
            code: `PP-9${prod.serial}`,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await owner.$disconnect();
    }
  });

  it('payments: two people allocating at once never allocate a payment twice or pay an invoice twice', async () => {
    await ensureCzkDefault();
    const [one, two] = [await freshInvoice(), await freshInvoice()];
    const [single, a, b] = [ref('H'), ref('I'), ref('J')];
    await simulate([
      { reference: single, amount: '4200.00' },
      { reference: a, amount: '4200.00' },
      { reference: b, amount: '4200.00' },
    ]).expect(200);
    const allocate = (code: string, invoiceNumber: string) =>
      f.post(`${PAY}/${code}/allocations`).send({
        requestId: randomUUID(),
        invoiceNumber,
        amount: '4200.00',
        reason: 'souběžné přiřazení (test)',
      });
    // The same payment to two invoices at once: exactly one wins.
    const p = (await payment(single)).code;
    const same = await Promise.all([allocate(p, one.number), allocate(p, two.number)]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(same.find((r) => r.status === 422)!.body.code).toBe('EXCEEDS_PAYMENT');
    expect((await payment(single)).allocated).toBe('4200.00');
    // Two payments completing the same (other) invoice at once: exactly one wins.
    const target = (await invoiceOf(one.number)).paymentState.state === 'PAID' ? two : one;
    const both = await Promise.all([
      allocate((await payment(a)).code, target.number),
      allocate((await payment(b)).code, target.number),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(both.find((r) => r.status === 422)!.body.code).toBe('EXCEEDS_INVOICE');
    expect((await invoiceOf(target.number)).paymentState).toMatchObject({
      state: 'PAID',
      paid: '4200.00',
    });
  });

  it('payments: simulation never in production; managing payments is ADMIN only', async () => {
    const prod = new PaymentsService(f.prisma, f.app.get(FinanceOperations), {
      ...f.env,
      APP_ENV: 'production',
    });
    await expect(
      prod.simulate({ requestId: randomUUID(), entries: [] }, {
        principal: { userId: randomUUID(), displayName: 'x' },
        sessionToken: 'x',
      } as never),
    ).rejects.toMatchObject({ response: { code: 'SIMULATION_DISABLED' } });
    expect((await prod.page()).simulationAvailable).toBe(false);
    expect((await payments()).simulationAvailable).toBe(true);
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const grants = await real.core.prisma.rolePermission.findMany({
        where: { permissionCode: 'finance:payments_manage' },
        select: { roleCode: true },
      });
      expect(grants.map((g) => g.roleCode)).toEqual(['ADMIN']);
      const roleCode = `FINP_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Faktury (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.create({
        data: { roleCode, permissionCode: 'finance:invoices_read' },
      });
      const user = await prepareInvitedUser(real.core, {
        email: `payments-${randomUUID()}@ayvo.test`,
        displayName: 'Jen čtení faktur',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: read only' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(PAY, cookie).expect(200);
      await real
        .post(`${PAY}/simulate`, cookie)
        .send({ requestId: randomUUID(), entries: [] })
        .expect(403);
      await real.post(`${PAY}/import-bank`, cookie).send({ requestId: randomUUID() }).expect(403);
    } finally {
      await real.close();
    }
  });

  // --- The Finance overview's sums and the agreement filter (doc 042 §3): reads only.

  it('overview (doc 042 §3a): the database sums equal the invoice list and the payments page; overdue as the payment state', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const [a, b] = [await agreement(c.id), await agreement(c.id)];
    const overdue = (await expectStatus(issue([a.code]), 201)).body as InvoiceDetail;
    const open = (await expectStatus(issue([b.code], '2026-08'), 201)).body as InvoiceDetail;
    // Test fixture: the first invoice was issued and due 60 days earlier (append-only otherwise).
    await withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`UPDATE "finance"."invoices" SET "issued_on" = "issued_on" - 60, "due_on" = "due_on" - 60
                             WHERE "number" = ${overdue.number}`;
      }),
    );
    // A partial payment of the open one: it stays open with the rest.
    await simulate([
      { reference: ref('OV'), amount: '1000.00', variableSymbol: open.variableSymbol },
    ]).expect(200);

    const overview = (await f.get(`${INV}/overview`).expect(200)).body as InvoicesOverview;
    const list = (await f.get(INV).expect(200)).body as InvoiceSummary[];
    expect(list.find((i) => i.number === overdue.number)!.paymentState.overdue).toBe(true);
    expect(list.find((i) => i.number === open.number)!.paymentState).toMatchObject({
      state: 'PARTIALLY_PAID',
      remaining: '3200.00',
      overdue: false,
    });
    const cents = (v: string) => Math.round(Number(v) * 100);
    const money = (c: number) => (c / 100).toFixed(2);
    const expected = new Map<string, { o: number; or: number; d: number; dr: number }>();
    for (const i of list) {
      if (i.status !== 'VALID' || i.paymentState.state === 'PAID') continue;
      const e = expected.get(i.currency) ?? { o: 0, or: 0, d: 0, dr: 0 };
      e.o += 1;
      e.or += cents(i.paymentState.remaining);
      if (i.paymentState.overdue) {
        e.d += 1;
        e.dr += cents(i.paymentState.remaining);
      }
      expected.set(i.currency, e);
    }
    expect(overview.invoices).toEqual(
      [...expected.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([currency, e]) => ({
          currency,
          open: { count: e.o, remaining: money(e.or) },
          overdue: { count: e.d, remaining: money(e.dr) },
        })),
    );
    expect(overview.invoices.find((x) => x.currency === 'CZK')!.overdue.count).toBeGreaterThan(0);
    // To review: an unallocated amount; changed at the bank: counted apart (FIN90-R1).
    const page = (await payments()).payments;
    expect(page.some((p) => p.state === 'ALLOCATED' && p.bankChangedSinceRecorded)).toBe(true);
    expect(overview.paymentsToReview).toBe(page.filter((p) => p.state !== 'ALLOCATED').length);
    expect(overview.paymentsChangedAtBank).toBe(
      page.filter((p) => p.bankChangedSinceRecorded).length,
    );
  });

  it('the agreement filter (doc 042 §3b): only invoices with a line of that agreement; unknown → none; malformed → 400', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const [a, b] = [await agreement(c.id), await agreement(c.id)];
    const both = (await expectStatus(issue([a.code, b.code], '2026-07'), 201))
      .body as InvoiceDetail;
    const onlyA = (await expectStatus(issue([a.code], '2026-06'), 201)).body as InvoiceDetail;
    const numbers = async (code: string) =>
      ((await f.get(`${INV}?agreement=${code}`).expect(200)).body as InvoiceSummary[]).map(
        (i) => i.number,
      );
    expect(await numbers(a.code)).toEqual([onlyA.number, both.number]);
    expect(await numbers(b.code)).toEqual([both.number]);
    expect(await numbers('BA-999999')).toEqual([]);
    await f.get(`${INV}?agreement=x`).expect(400);
  });

  it('the billing summary (doc 042 §3c): the counts of customers and agreements, nothing listed', async () => {
    const summary = (await f.get(`${B}/summary`).expect(200)).body as {
      customers: number;
      agreements: number;
    };
    const [customers, agreements] = await Promise.all([
      f.get(`${B}/customers`).expect(200),
      f.get(`${B}/agreements`).expect(200),
    ]);
    expect(summary).toEqual({
      customers: (customers.body as unknown[]).length,
      agreements: (agreements.body as unknown[]).length,
    });
    expect(summary.agreements).toBeGreaterThan(0);
  });

  it('the overview needs finance:invoices_read; billing alone is refused', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const roleCode = `FINB_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Smlouvy (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.create({
        data: { roleCode, permissionCode: 'finance:billing_read' },
      });
      const user = await prepareInvitedUser(real.core, {
        email: `overview-${randomUUID()}@ayvo.test`,
        displayName: 'Jen smlouvy',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: billing only' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(`${INV}/overview`, cookie).expect(403);
      await real.get(`${B}/summary`, cookie).expect(200);
      await real.get(`${INV}?agreement=BA-000001`, cookie).expect(403);
    } finally {
      await real.close();
    }
  });

  // --- The monthly run of TEST invoices (doc 040 §11): no new table, nothing derived.

  const RUN = `${INV}/test-run`;
  type Preview = TestRunPreview['items'][number];
  const previewOf = async (month: string) =>
    (await f.get(`${RUN}/preview?month=${month}`).expect(200)).body as TestRunPreview;
  const lineOf = (i: Preview) => ({
    agreementCode: i.agreementCode,
    agreementRevision: i.agreementRevision!,
    customerVersion: i.customer!.version,
    priceListVersionId: i.price.priceListVersionId,
    unitPrice: i.price.perRoomMonth!,
    billedRooms: i.billedRooms!,
  });
  const runFor = async (
    month: string,
    codes: string[],
    issuedOn = '2026-03-15',
    id = randomUUID(),
  ) => {
    const { items } = await previewOf(month);
    const lines = codes.map((c) => lineOf(items.find((i) => i.agreementCode === c)!));
    return f.post(RUN).send({ requestId: id, month, issuedOn, lines });
  };
  const invoiceCount = async () => ((await f.get(INV).expect(200)).body as unknown[]).length;

  it('the run preview says for each agreement what an invoice would be and why not; it saves nothing', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const month = '2026-02';
    const ready = await agreement(c.id);
    const bare = await agreement(c.id, { ownPricePerRoomMonth: null, currency: 'USD' });
    const partial = await agreement(c.id, { validFrom: '2026-02-10' });
    const zero = await agreement(c.id, { ownPricePerRoomMonth: '0.00' });
    const ended = await agreement(c.id, { validTo: '2026-01-31' });
    const before = await invoiceCount();
    const { items, issuable } = await previewOf(month);
    const of = (code: string) => items.find((i) => i.agreementCode === code)!;
    expect(issuable).toBe(true);
    expect(of(ready.code)).toMatchObject({
      state: 'READY',
      blockers: [],
      invoiceNumber: null,
      hotel: { code: ready.hotel.code },
      billedRooms: 12,
      price: { source: 'OWN', perRoomMonth: '350.00' },
      amount: '4200.00',
      currency: 'CZK',
      paymentTermsDays: 14,
      billingTiming: 'ARREARS',
    });
    expect(of(bare.code)).toMatchObject({
      state: 'BLOCKED',
      blockers: ['PRICE_MISSING'],
      amount: null,
    });
    expect(of(partial.code)).toMatchObject({
      state: 'BLOCKED',
      blockers: ['PARTIAL_PERIOD_RULE_MISSING'],
    });
    expect(of(zero.code)).toMatchObject({ state: 'BLOCKED', blockers: ['ZERO_AMOUNT'] });
    expect(of(ended.code)).toMatchObject({ state: 'NOT_IN_EFFECT', blockers: [] });
    expect(await invoiceCount()).toBe(before);
    // What the preview blocks, the run refuses (never a 0.00 invoice or a silent proration).
    for (const a of [partial, zero]) {
      const line = lineOf(of(a.code));
      const res = await f
        .post(RUN)
        .send({ requestId: randomUUID(), month, issuedOn: '2026-03-15', lines: [line] });
      expect(res.status, a.code).toBe(422);
    }
    expect(await invoiceCount()).toBe(before);
  });

  it('the run needs an explicit period and issue date; nothing is filled in', async () => {
    const c = await customer();
    const a = await agreement(c.id);
    const line = lineOf(
      (await previewOf('2026-02')).items.find((i) => i.agreementCode === a.code)!,
    );
    const base = { requestId: randomUUID(), lines: [line] };
    for (const body of [
      { ...base, month: '2026-02' },
      { ...base, issuedOn: '2026-03-15' },
      { ...base, month: '2026-02', issuedOn: '2026-02-31' },
      { ...base, month: '2026-02', issuedOn: '15.3.2026' },
      { ...base, month: '2026-02', issuedOn: '2026-03-15', lines: [] },
      { ...base, month: '2026-02', issuedOn: '2026-03-15', lines: [line, line] },
    ])
      await f.post(RUN).send(body).expect(400);
    await f.get(`${RUN}/preview`).expect(400);
  });

  it('one invoice per agreement with the explicit date; the same request replays, the next finds them invoiced', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const month = '2026-03';
    const [a, b] = [await agreement(c.id), await agreement(c.id, { paymentTermsDays: 30 })];
    const id = randomUUID();
    const res = await runFor(month, [a.code, b.code], '2026-04-02', id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const result = res.body as TestRunResult;
    expect(result.invoices.map((i) => i.agreementCode)).toEqual([a.code, b.code]);
    const [ia, ib] = await Promise.all(result.invoices.map((i) => invoiceOf(i.number)));
    expect(ia).toMatchObject({
      period: month,
      issuedOn: '2026-04-02',
      dueOn: '2026-04-16',
      total: '4200.00',
    });
    expect(ib).toMatchObject({ issuedOn: '2026-04-02', dueOn: '2026-05-02' });
    expect(ia!.lines.map((l) => l.agreementCode)).toEqual([a.code]);
    expect(ia!.number).toMatch(/^T2026-/);
    // A lost answer: the same request again creates nothing and answers the same.
    const count = await invoiceCount();
    const { items } = await previewOf(month);
    expect(items.find((i) => i.agreementCode === a.code)).toMatchObject({
      state: 'ALREADY_INVOICED',
      invoiceNumber: ia!.number,
    });
    const lines = [a, b].map((x) => ({
      agreementCode: x.code,
      agreementRevision: items.find((i) => i.agreementCode === x.code)!.agreementRevision!,
      customerVersion: items.find((i) => i.agreementCode === x.code)!.customer!.version,
      priceListVersionId: null,
      unitPrice: '350.00',
      billedRooms: 12,
    }));
    const again = await f.post(RUN).send({ requestId: id, month, issuedOn: '2026-04-02', lines });
    expect([again.status, again.body]).toEqual([201, result]);
    // The same id with anything else is a conflict; a new id is refused as invoiced.
    const other = await f.post(RUN).send({ requestId: id, month, issuedOn: '2026-04-03', lines });
    expect([other.status, other.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    const fresh = await f
      .post(RUN)
      .send({ requestId: randomUUID(), month, issuedOn: '2026-04-02', lines });
    expect([fresh.status, fresh.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    expect(await invoiceCount()).toBe(count);
    // A cancelled invoice frees its month: the preview offers it again, the other stays invoiced.
    await f
      .post(`${INV}/${ia!.number}/cancel`)
      .send({ requestId: randomUUID(), reason: 'test' })
      .expect(200);
    const after = (await previewOf(month)).items;
    expect(after.find((i) => i.agreementCode === a.code)!.state).toBe('READY');
    expect(after.find((i) => i.agreementCode === b.code)!.state).toBe('ALREADY_INVOICED');
  });

  it('all or nothing: a changed or invoiced agreement in the run leaves no invoice and no serial', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const month = '2026-05';
    const [a, b] = [await agreement(c.id), await agreement(c.id)];
    const { items } = await previewOf(month);
    const lines = [a, b].map((x) => lineOf(items.find((i) => i.agreementCode === x.code)!));
    const count = await invoiceCount();
    await changeTerms(b.code, { billedRooms: 13 });
    const stale = await f
      .post(RUN)
      .send({ requestId: randomUUID(), month, issuedOn: '2026-06-01', lines });
    expect([stale.status, stale.body.code]).toEqual([409, 'TERMS_CHANGED']);
    expect(await invoiceCount()).toBe(count);
    // One of them invoiced by hand meanwhile.
    await expectStatus(issue([a.code], month), 201);
    const now = (await previewOf(month)).items;
    const taken = await f.post(RUN).send({
      requestId: randomUUID(),
      month,
      issuedOn: '2026-06-01',
      lines: [a, b].map((x) => lineOf(now.find((i) => i.agreementCode === x.code)!)),
    });
    expect([taken.status, taken.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    expect(await invoiceCount()).toBe(count + 1);
  });

  it('two runs at once of the same agreement and month make exactly one invoice', async () => {
    await ensureCzkDefault();
    const c = await customer();
    const a = await agreement(c.id);
    const month = '2026-06';
    const count = await invoiceCount();
    const results = await Promise.all([runFor(month, [a.code]), runFor(month, [a.code])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await invoiceCount()).toBe(count + 1);
  });

  it('the run: never in production (the preview only says so); needs its permissions', async () => {
    const prod = new InvoicesService(
      f.prisma,
      f.app.get(FinanceOperations),
      f.app.get(BillingSettingsService),
      f.storage,
      { ...f.env, APP_ENV: 'production' },
    );
    await expect(
      prod.issueTestRun(
        { requestId: randomUUID(), month: '2026-02', issuedOn: '2026-03-15', lines: [] },
        { principal: { userId: randomUUID(), displayName: 'x' }, sessionToken: 'x' } as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'TEST_INVOICES_DISABLED' } });
    expect((await prod.testRunPreview('2026-02')).issuable).toBe(false);
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const roleCode = `FINR_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Čtení (test)', description: 'test' },
      });
      for (const permissionCode of ['finance:invoices_read', 'finance:billing_read'] as const)
        await real.core.prisma.rolePermission.create({ data: { roleCode, permissionCode } });
      const user = await prepareInvitedUser(real.core, {
        email: `run-${randomUUID()}@ayvo.test`,
        displayName: 'Jen čtení',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: read only' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(`${RUN}/preview?month=2026-02`, cookie).expect(403);
      await real.post(RUN, cookie).send({}).expect(403);
    } finally {
      await real.close();
    }
  });
});
