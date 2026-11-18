import { Injectable, NotFoundException } from '@nestjs/common';
import {
  commissionMonthNumber,
  commissionPhase,
  type AttributionCandidate,
  type HotelAttribution,
  type HotelAttributionRevision,
  type HotelTermsBinding,
  type Portfolio,
  type PortfolioQuery,
  type PortfolioRow,
  type RecordHotelAttributionRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { ContractDraftsService } from '../contracts/contract-drafts.service.js';
import { HotelsService } from '../customers/hotels.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { ProspectContextService } from '../sales/prospect-context.service.js';
import { SalespeopleService } from '../sales/salespeople.service.js';

type Db = Prisma.TransactionClient;
type AttributionRow = Prisma.SalesHotelAttributionGetPayload<{
  include: { bindings: { include: { terms: true } } };
}>;
type Person = { id: string; name: string };

const monthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
const toMonth = (d: Date) => d.toISOString().slice(0, 7);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

/** Terms are read only by the salesperson themselves and by ADMIN (doc 068 C2). */
const seesRates = (p: Principal, salespersonId: string | null) =>
  p.permissions.has('sales:commission_terms_manage') ||
  (salespersonId !== null && salespersonId === p.userId);

const invalid = (code: string, message: string) => domainError(422, code, message);

/**
 * Who gets the commission for a hotel and the terms applied to it (doc 068 §3.2–§3.3, §4.2;
 * PR 1b). Append-only revisions per hotel; for a service month the newest revision in force
 * decides. The salesperson's valid terms version is copied as the hotel's snapshot in the same
 * transaction and never re-read; a later terms version does not touch it. No amount, invoice or
 * payment is computed or shown here — those come only from Finance (PR 2/3).
 */
@Injectable()
export class HotelAttributionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly salespeople: SalespeopleService,
    private readonly hotels: HotelsService,
    private readonly contracts: ContractDraftsService,
    private readonly prospects: ProspectContextService,
  ) {}

  // --- the hotel card (sales:manage + hotels:read) ------------------------------------------

  detail(code: string, p: Principal): Promise<HotelAttribution> {
    return this.prisma.$transaction(async (tx) => {
      const hotel = await this.hotels.byCode(code, tx);
      if (!hotel) throw new NotFoundException('Hotel not found');
      const rows = await this.revisions(tx, hotel.id);
      const people = await this.salespeople.list(tx);
      const names = await this.names(tx, rows);
      const drafts = await this.draftCodes(tx, rows);
      const prospectCodes = new Map<string, string>();
      for (const id of new Set(rows.flatMap((r) => (r.prospectId ? [r.prospectId] : [])))) {
        const x = await this.prospects.visibleById(tx, id, p);
        if (x) prospectCodes.set(id, x.code);
      }
      const candidates: AttributionCandidate[] = [];
      for (const s of await this.contracts.signedAcquisitionSources(hotel.id, tx)) {
        const prospect = s.prospectId
          ? await this.prospects.visibleById(tx, s.prospectId, p)
          : null;
        const owner = prospect ? people.find((x) => x.id === prospect.ownerId) : undefined;
        candidates.push({
          draftCode: s.draftCode,
          revision: s.revision,
          signedOn: s.signedOn,
          startOn: s.startOn,
          prospectCode: prospect?.code ?? null,
          prospectName: prospect?.name ?? null,
          prefilledSalesperson: owner ?? null,
          prefilledMonth: s.startOn.slice(0, 7),
        });
      }
      const valid = await this.validTerms(
        tx,
        people.map((x) => x.id),
      );
      return {
        hotel: { code: hotel.code, name: hotel.name },
        revision: rows[0]?.revision ?? 0,
        commissionStart: rows.length ? toMonth(rows[rows.length - 1]!.commissionStart) : null,
        history: rows.map((r) => this.toRevision(r, { names, drafts, prospectCodes }, p)),
        candidates,
        salespeople: people.map((x) => {
          const t = valid.get(x.id);
          return {
            ...x,
            validTerms: t ? this.binding(t, p, x.id) : null,
          };
        }),
      };
    });
  }

  /**
   * A new revision. Serialised per hotel (advisory lock, then expectedRevision → 409); idempotent
   * per requestId. Revision 1 fixes the first paid month (explicitly confirmed) and is in force
   * from it; a later revision changes the salesperson from its month and never moves the start.
   */
  async record(
    code: string,
    req: RecordHotelAttributionRequest,
    p: Principal,
  ): Promise<HotelAttribution> {
    if (req.source === 'MANUAL' && (req.contractDraftCode || req.contractRevision))
      throw invalid('SOURCE_INVALID', 'Ruční přiřazení nemá smlouvu.');
    if (req.source === 'CONTRACT' && (!req.contractDraftCode || !req.contractRevision))
      throw invalid('SOURCE_INVALID', 'Vyberte podepsanou smlouvu.');
    await this.operations.run(
      'SALES_HOTEL_ATTRIBUTION_RECORD',
      req.requestId,
      { ...req, hotelCode: code, actorId: p.userId },
      async (tx) => {
        const hotel = await this.hotels.byCode(code, tx);
        if (!hotel) throw new NotFoundException('Hotel not found');
        const key = `sales-attribution:${hotel.id}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const rows = await this.revisions(tx, hotel.id);
        const current = rows[0]?.revision ?? 0;
        if (current !== req.expectedRevision)
          throw domainError(
            409,
            'CONCURRENT_CHANGE',
            'Mezitím se přiřazení změnilo. Načtěte ho znovu.',
          );

        let commissionStart: string;
        let effectiveFrom: string;
        if (current === 0) {
          if (!req.commissionStart)
            throw invalid('COMMISSION_START_REQUIRED', 'Zadejte první zpoplatněný měsíc.');
          if (req.confirmCommissionStart !== true)
            throw invalid('COMMISSION_START_NOT_CONFIRMED', 'Potvrďte první zpoplatněný měsíc.');
          if (req.effectiveFrom && req.effectiveFrom !== req.commissionStart)
            throw invalid(
              'EFFECTIVE_FROM_INVALID',
              'První přiřazení platí od prvního zpoplatněného měsíce.',
            );
          commissionStart = req.commissionStart;
          effectiveFrom = req.commissionStart;
        } else {
          commissionStart = toMonth(rows[rows.length - 1]!.commissionStart);
          if (req.commissionStart && req.commissionStart !== commissionStart)
            throw invalid(
              'COMMISSION_START_FIXED',
              'První zpoplatněný měsíc se změnou obchodníka nemění.',
            );
          if (!req.effectiveFrom)
            throw invalid('EFFECTIVE_FROM_INVALID', 'Zadejte měsíc, od kterého změna platí.');
          if (req.effectiveFrom < commissionStart)
            throw invalid(
              'EFFECTIVE_FROM_BEFORE_START',
              'Změna nemůže platit před prvním zpoplatněným měsícem.',
            );
          effectiveFrom = req.effectiveFrom;
        }

        let contract: {
          draftId: string;
          revision: number;
          startOn: string;
          prospectId: string | null;
        } | null = null;
        let prefilled: string | null = null;
        if (req.source === 'CONTRACT') {
          const src = await this.contracts.signedSource(
            tx,
            req.contractDraftCode!,
            req.contractRevision!,
          );
          if (!src || !src.signed)
            throw invalid('CONTRACT_NOT_SIGNED', 'Tato revize smlouvy nemá podepsaný originál.');
          if (src.hotelId !== hotel.id)
            throw invalid('CONTRACT_OTHER_HOTEL', 'Podepsaná smlouva patří jinému hotelu.');
          contract = src;
          const prospect = src.prospectId
            ? await this.prospects.visibleById(tx, src.prospectId, p)
            : null;
          prefilled = prospect?.ownerId ?? null;
        }

        if (req.salespersonId !== null && !(await this.salespeople.find(tx, req.salespersonId)))
          throw invalid(
            'SALESPERSON_NOT_ELIGIBLE',
            'Hotel lze přiřadit jen aktivnímu uživateli s oprávněním Obchod.',
          );

        const revision = current + 1;
        await tx.salesHotelAttribution.create({
          data: {
            hotelId: hotel.id,
            revision,
            effectiveFrom: monthDate(effectiveFrom),
            salespersonId: req.salespersonId,
            source: req.source,
            contractDraftId: contract?.draftId ?? null,
            contractRevision: contract?.revision ?? null,
            prospectId: contract?.prospectId ?? null,
            prefilledSalespersonId: prefilled,
            commissionStart: monthDate(commissionStart),
            contractStartOn: contract ? new Date(`${contract.startOn}T00:00:00.000Z`) : null,
            reason: req.reason,
            recordedBy: p.userId,
            requestId: req.requestId,
          },
        });
        // The salesperson's valid version becomes this hotel's snapshot, in the same transaction.
        // Without one, nothing is bound and the hotel shows "Chybí podmínky provize".
        if (req.salespersonId !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales-terms:${req.salespersonId}`}, 0))`;
          const terms = (await this.validTerms(tx, [req.salespersonId])).get(req.salespersonId);
          if (terms)
            await tx.salesHotelCommissionTerms.create({
              data: {
                hotelId: hotel.id,
                attributionRevision: revision,
                bindingNo: 1,
                kind: 'ON_ATTRIBUTION',
                effectiveFrom: monthDate(effectiveFrom),
                termsId: terms.id,
                initialRate: terms.initialRate,
                initialMonths: terms.initialMonths,
                maintenanceRate: terms.maintenanceRate,
                recordedBy: p.userId,
              },
            });
        }
        return { hotelCode: code };
      },
    );
    return this.detail(code, p);
  }

  // --- the portfolio (sales:work own; sales:manage everyone) ---------------------------------

  /**
   * The hotels attributed for a service month. A salesperson gets their own hotels only, always
   * from the session; naming a salesperson needs `sales:manage`. Code, name and city of the
   * hotel only (doc 068 Q4) — no contact, address, order, invoice or payment.
   */
  portfolio(q: PortfolioQuery, p: Principal): Promise<Portfolio> {
    const manage = p.permissions.has('sales:manage');
    if (q.salesperson && !manage)
      throw domainError(403, 'FORBIDDEN', 'Portfolio jiného obchodníka vidí jen vedoucí.');
    const only = manage ? (q.salesperson ?? null) : p.userId;
    return this.prisma.$transaction(async (tx) => {
      const month = monthDate(q.month);
      // The revision in force for the month: the largest revision among effective_from <= M.
      const inForce = await tx.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT ON ("hotel_id") "id" FROM "sales_hotel_attributions"
        WHERE "effective_from" <= ${month}::date
        ORDER BY "hotel_id", "revision" DESC`;
      const rows = (
        await tx.salesHotelAttribution.findMany({
          where: { id: { in: inForce.map((r) => r.id) } },
          include: { bindings: { include: { terms: true } } },
        })
      ).filter((r) => (only === null ? true : r.salespersonId === only));
      const firsts = new Map(
        (
          await tx.salesHotelAttribution.findMany({
            where: { hotelId: { in: rows.map((r) => r.hotelId) }, revision: 1 },
            select: { hotelId: true, commissionStart: true },
          })
        ).map((r) => [r.hotelId, toMonth(r.commissionStart)]),
      );
      const drafts = await this.draftCodes(tx, rows);
      const hotels = new Map(
        (await this.hotels.identities(rows.map((r) => r.hotelId))).map((h) => [h.id, h]),
      );
      const names = await this.names(tx, rows);
      const out: PortfolioRow[] = rows.map((r) => {
        const hotel = hotels.get(r.hotelId)!;
        const start = firsts.get(r.hotelId)!;
        const k = commissionMonthNumber(start, q.month);
        const b = r.bindings[0];
        const visible = seesRates(p, r.salespersonId);
        const state: PortfolioRow['state'] =
          k < 1
            ? 'BEFORE_START'
            : r.salespersonId === null
              ? 'NO_SALESPERSON'
              : !b
                ? 'MISSING_TERMS'
                : commissionPhase(k, b.initialMonths);
        return {
          hotel: { code: hotel.code, name: hotel.name, city: hotel.city },
          salesperson: r.salespersonId ? (names.get(r.salespersonId) ?? null) : null,
          since: toMonth(r.effectiveFrom),
          source: r.source as PortfolioRow['source'],
          contractDraftCode: r.contractDraftId ? (drafts.get(r.contractDraftId) ?? null) : null,
          commissionStart: start,
          k,
          state,
          rate:
            b && visible && (state === 'INITIAL' || state === 'MAINTENANCE')
              ? (state === 'INITIAL' ? b.initialRate : b.maintenanceRate).toFixed(2)
              : null,
          termsVersion: b?.terms.version ?? null,
        };
      });
      out.sort(
        (a, b) =>
          a.hotel.name.localeCompare(b.hotel.name, 'cs') ||
          a.hotel.code.localeCompare(b.hotel.code),
      );
      let totals: Portfolio['totals'] = null;
      if (manage) {
        const counts = new Map<string | null, number>();
        for (const r of rows) counts.set(r.salespersonId, (counts.get(r.salespersonId) ?? 0) + 1);
        totals = [...counts.entries()]
          .map(([id, hotelsCount]) => ({
            salesperson: id ? (names.get(id) ?? null) : null,
            hotels: hotelsCount,
          }))
          .sort((a, b) =>
            (a.salesperson?.name ?? '').localeCompare(b.salesperson?.name ?? '', 'cs'),
          );
      }
      return { month: q.month, rows: out, totals };
    });
  }

  // --- helpers --------------------------------------------------------------------------------

  /** Every revision of the hotel, newest first, with its binding. */
  private revisions(db: Db, hotelId: string): Promise<AttributionRow[]> {
    return db.salesHotelAttribution.findMany({
      where: { hotelId },
      include: { bindings: { include: { terms: true }, orderBy: { bindingNo: 'desc' } } },
      orderBy: { revision: 'desc' },
    });
  }

  private async draftCodes(db: Db, rows: { contractDraftId: string | null }[]) {
    const ids = [...new Set(rows.flatMap((r) => (r.contractDraftId ? [r.contractDraftId] : [])))];
    return new Map((await this.contracts.draftCodes(db, ids)).map((d) => [d.id, d.code]));
  }

  /** The valid (newest) terms version of each salesperson. */
  private async validTerms(db: Db, ids: string[]) {
    const rows = await db.salesCommissionTerms.findMany({
      where: { salespersonId: { in: ids } },
      orderBy: [{ salespersonId: 'asc' }, { version: 'desc' }],
      distinct: ['salespersonId'],
    });
    return new Map(rows.map((r) => [r.salespersonId, r]));
  }

  private binding(
    t: {
      version: number;
      initialRate: Prisma.Decimal;
      initialMonths: number;
      maintenanceRate: Prisma.Decimal;
    },
    p: Principal,
    salespersonId: string | null,
  ): HotelTermsBinding {
    const visible = seesRates(p, salespersonId);
    return {
      termsVersion: t.version,
      initialRate: visible ? t.initialRate.toFixed(2) : null,
      initialMonths: visible ? t.initialMonths : null,
      maintenanceRate: visible ? t.maintenanceRate.toFixed(2) : null,
    };
  }

  /** Display names of everyone a set of revisions names (salesperson, offered, recorder). */
  private async names(
    db: Db,
    rows: {
      salespersonId: string | null;
      prefilledSalespersonId?: string | null;
      recordedBy: string;
    }[],
  ): Promise<Map<string, Person>> {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.salespersonId) ids.add(r.salespersonId);
      if (r.prefilledSalespersonId) ids.add(r.prefilledSalespersonId);
      ids.add(r.recordedBy);
    }
    const users = await db.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, { id: u.id, name: u.displayName }]));
  }

  private toRevision(
    r: AttributionRow,
    refs: {
      names: Map<string, Person>;
      drafts: Map<string, string>;
      prospectCodes: Map<string, string>;
    },
    p: Principal,
  ): HotelAttributionRevision {
    const { names } = refs;
    const b = r.bindings[0];
    return {
      revision: r.revision,
      effectiveFrom: toMonth(r.effectiveFrom),
      salesperson: r.salespersonId ? (names.get(r.salespersonId) ?? null) : null,
      source: r.source as HotelAttributionRevision['source'],
      contract:
        r.contractDraftId && r.contractRevision && r.contractStartOn
          ? {
              draftCode: refs.drafts.get(r.contractDraftId) ?? '',
              revision: r.contractRevision,
              startOn: toDay(r.contractStartOn),
            }
          : null,
      prospectCode: r.prospectId ? (refs.prospectCodes.get(r.prospectId) ?? null) : null,
      prefilledSalesperson: r.prefilledSalespersonId
        ? (names.get(r.prefilledSalespersonId) ?? null)
        : null,
      commissionStart: toMonth(r.commissionStart),
      startDiffersFromContract:
        r.contractStartOn !== null && toMonth(r.contractStartOn) !== toMonth(r.commissionStart),
      reason: r.reason,
      recordedAt: r.recordedAt.toISOString(),
      recordedByName: names.get(r.recordedBy)?.name ?? '',
      binding: b
        ? this.binding(
            {
              version: b.terms.version,
              initialRate: b.initialRate,
              initialMonths: b.initialMonths,
              maintenanceRate: b.maintenanceRate,
            },
            p,
            r.salespersonId,
          )
        : null,
    };
  }
}
