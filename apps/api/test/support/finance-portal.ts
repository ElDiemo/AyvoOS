import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { newStorageKey } from '../../src/storage/file-storage.js';
import type { FinanceTestApp } from './finance-app.js';
import { createHotel } from './order-fixtures.js';
import { withPrivileged } from './test-app.js';

/**
 * Synthetic payers, hotels, agreements and TEST invoices for the hotel portal tests (ADR 0045):
 * payers, hotels and agreements through the admin routes, as an administrator would; invoices as
 * synthetic rows (below).
 */
const B = '/api/admin/finance/billing';

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

/**
 * A synthetic TEST invoice of these agreements for a month, written by SQL with triggers off — as
 * if issued, with its lines (hotel, agreement revision, customer version as stored when issued)
 * and a stored "PDF" whose SHA-256 is recorded. It needs no issuer: the issuer is one per
 * installation, and the issuer tests expect to set it up themselves.
 */
export async function invoice(
  f: FinanceTestApp,
  agreementCodes: string[],
  month = '2026-09',
  pdf: Buffer = randomBytes(2048),
) {
  const agreements = await Promise.all(
    agreementCodes.map((code) =>
      f.prisma.billingAgreement.findUniqueOrThrow({
        where: { code },
        include: { versions: { orderBy: { revision: 'desc' }, take: 1 } },
      }),
    ),
  );
  const customerId = agreements[0]!.versions[0]!.customerId;
  const { version } = await f.prisma.customerVersion.findFirstOrThrow({
    where: { customerId },
    orderBy: { version: 'desc' },
  });
  const id = randomUUID();
  const digits = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  const number = `T${digits(4)}-${digits(5)}`;
  const key = newStorageKey('finance-documents', 'pdf');
  await f.storage.put(key, pdf);
  const sha = createHash('sha256').update(pdf).digest('hex');
  const amount = '1000.00';
  await withPrivileged((db) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "finance"."invoices" ("id", "serial", "kind", "number", "variable_symbol",
           "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
           "total", "snapshot", "pdf_storage_key", "pdf_sha256", "issued_by", "issued_by_name",
           "request_id")
         VALUES ($1::uuid, $2, 'TEST', $3, $4, $5::uuid, $6, $7::date, current_date,
           current_date + 14, 'CZK', $8::numeric, '{}'::jsonb, $9, $10, $11::uuid,
           'Syntetický test', $12::uuid)`,
        id,
        BigInt(900_000_000 + Math.floor(Math.random() * 99_000_000)),
        number,
        `9${digits(9)}`,
        customerId,
        version,
        `${month}-01`,
        (Number(amount) * agreements.length).toFixed(2),
        key,
        sha,
        randomUUID(),
        randomUUID(),
      );
      let line = 1;
      for (const a of agreements)
        await tx.$executeRawUnsafe(
          `INSERT INTO "finance"."invoice_lines" ("invoice_id", "line_no", "agreement_id",
             "agreement_revision", "period_month", "hotel_id", "hotel_code", "hotel_name",
             "billed_rooms", "unit_price", "amount")
           VALUES ($1::uuid, $2, $3::uuid, $4, $5::date, $6::uuid, $7, $8, 10, 100.00, $9::numeric)`,
          id,
          line++,
          a.id,
          a.versions[0]!.revision,
          `${month}-01`,
          a.hotelId,
          a.hotelCode,
          a.hotelName,
          amount,
        );
    }),
  );
  return { id, number, pdfSha256: sha };
}
