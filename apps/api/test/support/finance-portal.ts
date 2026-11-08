import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { EffectiveTermsPage, IssuerSettings } from '@ayvo/types';
import type { FinanceTestApp } from './finance-app.js';
import { createHotel } from './order-fixtures.js';

/**
 * Synthetic payers, hotels, agreements and TEST invoices for the hotel portal tests (ADR 0045):
 * everything through Finance's and the core's own admin routes, as an administrator would.
 */
const B = '/api/admin/finance/billing';
const I = '/api/admin/finance/issuer';
const INV = '/api/admin/finance/invoices';

/** A synthetic payer (Finance customer). */
export async function payer(f: FinanceTestApp, name = 'Plátce') {
  const res = await f.post(`${B}/customers`).send({
    requestId: randomUUID(),
    customer: {
      legalName: `${name} ${randomUUID().slice(0, 6)} s.r.o.`,
      companyId: '87654321',
      vatId: null,
      addressLine1: 'Hotelová 7',
      addressLine2: null,
      postalCode: '602 00',
      city: 'Brno',
      countryCode: 'CZ',
      billingEmail: 'fakturace@hotely.test',
      documentLanguage: 'cs',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; code: string };
}

/** A synthetic core hotel with its id. */
export async function hotel(f: FinanceTestApp, name?: string) {
  const h = await createHotel(f.core, name ? { name } : {});
  const { id } = await f.core.prisma.hotel.findUniqueOrThrow({
    where: { code: h.code },
    select: { id: true },
  });
  return { id, code: h.code, name: h.name };
}

/** The hotel's billing agreement, terms from 2026-01 for this payer. */
export async function agreement(
  f: FinanceTestApp,
  payerId: string,
  hotelId: string,
  over: Record<string, unknown> = {},
) {
  const res = await f.post(`${B}/agreements`).send({
    requestId: randomUUID(),
    hotelId,
    terms: {
      effectiveFrom: '2026-01',
      customerId: payerId,
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
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { code: string; versions: { revision: number }[] };
}

/** A new version of the agreement's terms (e.g. the hotel moves to another payer). */
export async function newTerms(f: FinanceTestApp, code: string, over: Record<string, unknown>) {
  const detail = (await f.get(`${B}/agreements/${code}`).expect(200)).body as {
    versions: { revision: number; terms: Record<string, unknown> }[];
  };
  const current = detail.versions[0]!;
  const res = await f.post(`${B}/agreements/${code}/versions`).send({
    requestId: randomUUID(),
    expectedRevision: current.revision,
    terms: {
      effectiveFrom: '2026-01',
      contractNumber: null,
      billedRooms: 12,
      ownPricePerRoomMonth: '350.00',
      currency: 'CZK',
      paymentTermsDays: 14,
      billingTiming: 'ARREARS',
      validFrom: '2026-01-01',
      validTo: null,
      reason: 'Změna (syntetická)',
      ...over,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** An issuer and an active default CZK account, as needed to issue TEST invoices. */
export async function ensureIssuing(f: FinanceTestApp) {
  let s = (await f.get(I).expect(200)).body as IssuerSettings;
  if (!s.current) {
    const res = await f.post(`${I}/versions`).send({
      requestId: randomUUID(),
      expectedVersion: 0,
      issuer: {
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
      },
      reason: 'test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    s = (await f.get(I).expect(200)).body as IssuerSettings;
  }
  const d = s.defaults.find((x) => x.currency === 'CZK');
  const chosen = d && s.accounts.find((a) => a.code === d.accountCode);
  if (chosen?.current.status === 'ACTIVE') return;
  const created = await f.post(`${I}/bank-accounts`).send({
    requestId: randomUUID(),
    account: {
      label: `Účet CZK (test ${randomUUID().slice(0, 4)})`,
      currency: 'CZK',
      accountPrefix: '19',
      accountNumber: '2000145399',
      bankCode: '0800',
      iban: 'CZ65 0800 0000 1920 0014 5399',
      bic: 'GIBACZPX',
    },
    reason: 'Zřízení (test)',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const fresh = (created.body as IssuerSettings).accounts.at(-1)!;
  const set = await f.post(`${I}/default-accounts`).send({
    requestId: randomUUID(),
    currency: 'CZK',
    accountCode: fresh.code,
    expectedRevision: d?.revision ?? null,
    reason: 'Volba výchozího účtu (test)',
  });
  expect(set.status, JSON.stringify(set.body)).toBe(201);
}

/** A TEST invoice of these agreements for a month (one payer), as the issuing form sends it. */
export async function invoice(f: FinanceTestApp, agreementCodes: string[], month = '2026-09') {
  const items = (
    (await f.get(`${B}/agreements/effective?month=${month}`).expect(200)).body as EffectiveTermsPage
  ).items;
  const lines = agreementCodes.map((code) => {
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
  const res = await f.post(`${INV}/test`).send({ requestId: randomUUID(), month, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { number } = res.body as { number: string };
  return f.prisma.invoice.findUniqueOrThrow({
    where: { number },
    select: { id: true, number: true },
  });
}
