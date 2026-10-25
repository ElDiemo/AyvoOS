import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  BillingAgreement,
  BillingAgreementDetail,
  BillingAgreementTerms,
  BillingAgreementVersion,
  BillingCustomer,
  BillingCustomerDetail,
  BillingCustomerFields,
  BillingCustomerVersion,
  BillingGap,
  CreateBillingAgreementRequest,
  CreateBillingCustomerRequest,
  EffectiveTerms,
  EffectiveTermsPage,
  NewBillingAgreementVersionRequest,
  NewBillingCustomerVersionRequest,
  NewPriceListVersionRequest,
  PriceListVersion,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import { CoreClient } from './core-client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

type CustomerVersionRow = Prisma.CustomerVersionGetPayload<object>;
type AgreementRow = Prisma.BillingAgreementGetPayload<object>;
type AgreementVersionRow = Prisma.AgreementVersionGetPayload<{ include: { customer: true } }>;
type PriceRow = Prisma.PriceListVersionGetPayload<object>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);
const monthStart = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
/** The last day of a "YYYY-MM" month (UTC date, as stored in DATE columns). */
const monthEnd = (m: string) => {
  const start = monthStart(m);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
};
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const isForeignKey = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003';

/** The newest recorded row among those effective at the newest effective_from ≤ the date. */
function effectiveAt<T extends { effectiveFrom: Date; recordedAt: Date }>(
  rows: readonly T[],
  date: Date,
  asOf: Date,
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.effectiveFrom > date || r.recordedAt > asOf) continue;
    if (
      !best ||
      r.effectiveFrom > best.effectiveFrom ||
      (r.effectiveFrom.getTime() === best.effectiveFrom.getTime() && r.recordedAt > best.recordedAt)
    )
      best = r;
  }
  return best;
}

/**
 * Hotel billing settings (doc 040, N3A-1): customers, one billing agreement per hotel with
 * versioned terms, the default price list, and the terms effective for a month — also as they
 * were known at an earlier moment. Everything is append-only; a change or a correction is a new
 * version with its author and reason. No amounts, VAT, numbering or invoices here (N3A-2).
 * Hotels come from the core contract only (never from its tables).
 */
@Injectable()
export class BillingSettingsService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    private readonly core: CoreClient,
  ) {}

  // --- customers ------------------------------------------------------------------------

  async listCustomers(): Promise<BillingCustomer[]> {
    const rows = await this.prisma.customer.findMany({
      orderBy: { serial: 'asc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    return rows.map((c) => ({ id: c.id, code: c.code, current: customerVersion(c.versions[0]!) }));
  }

  async customerDetail(code: string): Promise<BillingCustomerDetail> {
    const c = await this.prisma.customer.findUnique({
      where: { code },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!c) throw new NotFoundException('Odběratel nenalezen');
    const versions = c.versions.map(customerVersion);
    return { id: c.id, code: c.code, current: versions[0]!, versions };
  }

  async createCustomer(
    req: CreateBillingCustomerRequest,
    caller: FinanceCaller,
  ): Promise<BillingCustomerDetail> {
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'BILLING_CUSTOMER_CREATE',
      req.requestId,
      { customer: req.customer, actorId: userId },
      async (tx) => {
        const serial = await allocateFinanceSerial(tx, 'customer');
        const code = `CU-${String(serial).padStart(6, '0')}`;
        const created = await tx.customer.create({
          data: {
            serial,
            code,
            createdBy: userId,
            createdByName: displayName,
            requestId: req.requestId,
          },
        });
        await tx.customerVersion.create({
          data: {
            ...customerData(req.customer),
            customerId: created.id,
            version: 1,
            reason: null,
            recordedBy: userId,
            recordedByName: displayName,
            requestId: req.requestId,
          },
        });
        return { code };
      },
    );
    return this.customerDetail(result.code);
  }

  async newCustomerVersion(
    code: string,
    req: NewBillingCustomerVersionRequest,
    caller: FinanceCaller,
  ): Promise<BillingCustomerDetail> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'BILLING_CUSTOMER_VERSION',
      req.requestId,
      { code, customer: req.customer, reason: req.reason, actorId: userId },
      async (tx) => {
        const c = await tx.customer.findUnique({
          where: { code },
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        });
        if (!c) throw new NotFoundException('Odběratel nenalezen');
        try {
          await tx.customerVersion.create({
            data: {
              ...customerData(req.customer),
              customerId: c.id,
              version: c.versions[0]!.version + 1,
              reason: req.reason,
              recordedBy: userId,
              recordedByName: displayName,
              requestId: req.requestId,
            },
          });
        } catch (e) {
          // Two changes at once: the second loses (the runtime role cannot lock rows for update).
          if (isUnique(e)) throw concurrentChange();
          throw e;
        }
        return { code };
      },
    );
    return this.customerDetail(code);
  }

  // --- the default price list -----------------------------------------------------------

  async listPriceList(): Promise<PriceListVersion[]> {
    const rows = await this.prisma.priceListVersion.findMany({
      orderBy: [{ currency: 'asc' }, { effectiveFrom: 'desc' }, { recordedAt: 'desc' }],
    });
    return rows.map(priceVersion);
  }

  async newPriceListVersion(
    req: NewPriceListVersionRequest,
    caller: FinanceCaller,
  ): Promise<PriceListVersion> {
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'BILLING_PRICE_VERSION',
      req.requestId,
      {
        currency: req.currency,
        pricePerRoomMonth: req.pricePerRoomMonth,
        effectiveFrom: req.effectiveFrom,
        reason: req.reason,
        actorId: userId,
      },
      async (tx) => {
        const row = await tx.priceListVersion.create({
          data: {
            currency: req.currency,
            pricePerRoomMonth: new Prisma.Decimal(req.pricePerRoomMonth),
            effectiveFrom: monthStart(req.effectiveFrom),
            reason: req.reason,
            recordedBy: userId,
            recordedByName: displayName,
            requestId: req.requestId,
          },
        });
        return { id: row.id };
      },
    );
    const row = await this.prisma.priceListVersion.findUniqueOrThrow({ where: { id: result.id } });
    return priceVersion(row);
  }

  // --- hotel billing agreements ---------------------------------------------------------

  async listAgreements(): Promise<BillingAgreement[]> {
    const rows = await this.prisma.billingAgreement.findMany({ orderBy: { serial: 'asc' } });
    return rows.map(agreement);
  }

  async agreementDetail(code: string): Promise<BillingAgreementDetail> {
    const a = await this.prisma.billingAgreement.findUnique({
      where: { code },
      include: {
        versions: {
          include: { customer: true },
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        },
      },
    });
    if (!a) throw new NotFoundException('Smlouva nenalezena');
    return { ...agreement(a), versions: a.versions.map(agreementVersion) };
  }

  async createAgreement(
    req: CreateBillingAgreementRequest,
    caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    // The hotel is the core's record: it must exist now (checked through the contract).
    const hotel = (await this.core.lookupHotels(caller.sessionToken, [req.hotelId])).get(
      req.hotelId,
    );
    if (!hotel) throw domainError(422, 'HOTEL_NOT_FOUND', 'Hotel v AYVO OS neexistuje.');
    const { userId, displayName } = caller.principal;
    const { result } = await this.operations.run(
      'BILLING_AGREEMENT_CREATE',
      req.requestId,
      { hotelId: req.hotelId, terms: req.terms, actorId: userId },
      async (tx) => {
        const serial = await allocateFinanceSerial(tx, 'billing_agreement');
        const code = `BA-${String(serial).padStart(6, '0')}`;
        try {
          const created = await tx.billingAgreement.create({
            data: {
              serial,
              code,
              hotelId: hotel.id,
              hotelCode: hotel.code,
              hotelName: hotel.name,
              createdBy: userId,
              createdByName: displayName,
              requestId: req.requestId,
            },
          });
          await tx.agreementVersion.create({
            data: versionData(created.id, req.terms, userId, displayName, req.requestId),
          });
        } catch (e) {
          if (isUnique(e))
            throw domainError(409, 'AGREEMENT_EXISTS', 'Tento hotel už fakturační smlouvu má.');
          if (isForeignKey(e)) throw customerNotFound();
          throw e;
        }
        return { code };
      },
    );
    return this.agreementDetail(result.code);
  }

  async newAgreementVersion(
    code: string,
    req: NewBillingAgreementVersionRequest,
    caller: FinanceCaller,
  ): Promise<BillingAgreementDetail> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'BILLING_AGREEMENT_VERSION',
      req.requestId,
      { code, terms: req.terms, actorId: userId },
      async (tx) => {
        const a = await tx.billingAgreement.findUnique({ where: { code } });
        if (!a) throw new NotFoundException('Smlouva nenalezena');
        try {
          await tx.agreementVersion.create({
            data: versionData(a.id, req.terms, userId, displayName, req.requestId),
          });
        } catch (e) {
          if (isForeignKey(e)) throw customerNotFound();
          throw e;
        }
        return { code };
      },
    );
    return this.agreementDetail(code);
  }

  // --- terms effective for a month ------------------------------------------------------

  /**
   * The terms of every agreement for the month, as known at `asOf` (default: now). Read only, no
   * amounts: the effective version, the customer's details then, the price source, and what is
   * missing (never guessed, never skipped silently).
   */
  async effectiveTerms(m: string, asOfIso?: string): Promise<EffectiveTermsPage> {
    const asOf = asOfIso ? new Date(asOfIso) : new Date();
    const start = monthStart(m);
    const end = monthEnd(m);
    const [agreements, prices, customerVersions] = await Promise.all([
      this.prisma.billingAgreement.findMany({
        where: { createdAt: { lte: asOf } },
        orderBy: { serial: 'asc' },
        include: { versions: { include: { customer: true } } },
      }),
      this.prisma.priceListVersion.findMany({ where: { recordedAt: { lte: asOf } } }),
      this.prisma.customerVersion.findMany({ where: { recordedAt: { lte: asOf } } }),
    ]);
    const items = agreements.map((a): EffectiveTerms => {
      const known = a.versions.filter((v) => v.recordedAt <= asOf);
      const v = effectiveAt(known, start, asOf);
      const overlaps = (x: AgreementVersionRow) =>
        x.validFrom <= end && (x.validTo === null || x.validTo >= start);
      const base = { agreement: agreement(a) };
      const noPrice = { source: 'MISSING' as const, perRoomMonth: null, priceListVersionId: null };
      if (!v) {
        // Terms start later; if some known version's validity reaches into the month, its terms
        // for this month are missing — listed, never assumed.
        const inMonth = known.some(overlaps);
        return {
          ...base,
          status: inMonth ? 'IN_EFFECT' : 'NOT_IN_EFFECT',
          version: null,
          customer: null,
          price: noPrice,
          gaps: inMonth ? ['NO_EFFECTIVE_VERSION'] : [],
        };
      }
      if (!overlaps(v))
        return {
          ...base,
          status: 'NOT_IN_EFFECT',
          version: agreementVersion(v),
          customer: null,
          price: noPrice,
          gaps: [],
        };
      const gaps: BillingGap[] = [];
      // A month the agreement covers only partly: no proration rule is decided (doc 040 §4).
      if (v.validFrom > start || (v.validTo !== null && v.validTo < end))
        gaps.push('PARTIAL_PERIOD_RULE_MISSING');
      let price: EffectiveTerms['price'];
      if (v.ownPricePerRoomMonth !== null) {
        price = {
          source: 'OWN',
          perRoomMonth: money(v.ownPricePerRoomMonth),
          priceListVersionId: null,
        };
      } else {
        const p = effectiveAt(
          prices.filter((x) => x.currency === v.currency),
          start,
          asOf,
        );
        price = p
          ? {
              source: 'DEFAULT',
              perRoomMonth: money(p.pricePerRoomMonth),
              priceListVersionId: p.id,
            }
          : noPrice;
        if (!p) gaps.push('PRICE_MISSING');
      }
      const cv = customerVersions
        .filter((x) => x.customerId === v.customerId)
        .reduce<CustomerVersionRow | null>((b, x) => (!b || x.version > b.version ? x : b), null);
      return {
        ...base,
        status: 'IN_EFFECT',
        version: agreementVersion(v),
        customer: cv ? { ...customerVersion(cv), id: v.customer.id, code: v.customer.code } : null,
        price,
        gaps,
      };
    });
    return { month: m, asOf: asOf.toISOString(), items };
  }
}

const concurrentChange = () =>
  domainError(409, 'CONCURRENT_CHANGE', 'Údaje mezitím změnil někdo jiný. Načtěte je znovu.');
const customerNotFound = () =>
  domainError(422, 'CUSTOMER_NOT_FOUND', 'Zvolený odběratel neexistuje.');

function customerData(c: BillingCustomerFields) {
  return {
    legalName: c.legalName,
    companyId: c.companyId,
    vatId: c.vatId,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    countryCode: c.countryCode,
    billingEmail: c.billingEmail,
  };
}

function versionData(
  agreementId: string,
  t: BillingAgreementTerms,
  userId: string,
  displayName: string,
  requestId: string,
): Prisma.AgreementVersionUncheckedCreateInput {
  return {
    agreementId,
    effectiveFrom: monthStart(t.effectiveFrom),
    customerId: t.customerId,
    contractNumber: t.contractNumber,
    billedRooms: t.billedRooms,
    ownPricePerRoomMonth:
      t.ownPricePerRoomMonth === null ? null : new Prisma.Decimal(t.ownPricePerRoomMonth),
    currency: t.currency,
    paymentTermsDays: t.paymentTermsDays,
    billingTiming: t.billingTiming,
    validFrom: new Date(`${t.validFrom}T00:00:00.000Z`),
    validTo: t.validTo === null ? null : new Date(`${t.validTo}T00:00:00.000Z`),
    reason: t.reason,
    recordedBy: userId,
    recordedByName: displayName,
    requestId,
  };
}

function customerVersion(v: CustomerVersionRow): BillingCustomerVersion {
  return {
    version: v.version,
    customer: {
      legalName: v.legalName,
      companyId: v.companyId,
      vatId: v.vatId,
      addressLine1: v.addressLine1,
      addressLine2: v.addressLine2,
      postalCode: v.postalCode,
      city: v.city,
      countryCode: v.countryCode,
      billingEmail: v.billingEmail,
    },
    reason: v.reason,
    recordedAt: v.recordedAt.toISOString(),
    recordedByName: v.recordedByName,
  };
}

function priceVersion(p: PriceRow): PriceListVersion {
  return {
    id: p.id,
    currency: p.currency,
    pricePerRoomMonth: p.pricePerRoomMonth.toFixed(2),
    effectiveFrom: month(p.effectiveFrom),
    reason: p.reason,
    recordedAt: p.recordedAt.toISOString(),
    recordedByName: p.recordedByName,
  };
}

function agreement(a: AgreementRow): BillingAgreement {
  return {
    id: a.id,
    code: a.code,
    hotel: { id: a.hotelId, code: a.hotelCode, name: a.hotelName },
    createdAt: a.createdAt.toISOString(),
    createdByName: a.createdByName,
  };
}

function agreementVersion(v: AgreementVersionRow): BillingAgreementVersion {
  return {
    id: v.id,
    effectiveFrom: month(v.effectiveFrom),
    customer: { id: v.customer.id, code: v.customer.code },
    contractNumber: v.contractNumber,
    billedRooms: v.billedRooms,
    ownPricePerRoomMonth: money(v.ownPricePerRoomMonth),
    currency: v.currency,
    paymentTermsDays: v.paymentTermsDays,
    billingTiming: v.billingTiming as BillingAgreementVersion['billingTiming'],
    validFrom: day(v.validFrom),
    validTo: v.validTo ? day(v.validTo) : null,
    reason: v.reason,
    recordedAt: v.recordedAt.toISOString(),
    recordedByName: v.recordedByName,
  };
}
