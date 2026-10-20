import { randomUUID } from 'node:crypto';
import type {
  ActivateSupplyPlanRequest,
  PauseSupplyPlanRequest,
  SaveSupplyPlanRequest,
  SupplyBlocker,
  SupplyLine,
  SupplyPlan,
  SupplyPlanPreviewRequest,
  SupplyPreview,
} from '@ayvo/types';
import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { derivedRequestId } from '../common/derived-request-id.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { HotelsService } from '../customers/hotels.service.js';
import { OperationRequestsService, payloadHash } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { localDate, OrdersService } from './orders.service.js';
import { addDays, nextPlannedDay, plannedDays, type CalendarRule } from './supply-calendar.js';

type Tx = Prisma.TransactionClient;

/** Orders are created for today and the following 13 local days of the serving site. */
export const SUPPLY_HORIZON_DAYS = 14;
/** The preview shows the next 30 days. */
export const SUPPLY_PREVIEW_DAYS = 30;

const BLOCKER_CODES = new Set<SupplyBlocker['code']>([
  'UNKNOWN_PRODUCT',
  'PRODUCT_WITHOUT_RECIPE',
  'SITE_WITHOUT_WAREHOUSE',
  'HOTEL_OF_ANOTHER_SITE',
  'SITE_INACTIVE',
  'ORDER_REFUSED',
]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);

/**
 * Hotel supply plans (doc 032). Managing a plan (rules, preview, switching on, pausing) and the
 * safe generation of ordinary orders from it — in the existing background rounds. The generator
 * only creates orders, through the same rules as a manual order (OrdersService.insertOrder); it
 * never touches a carrier, stock or crate cycles. One occurrence (plan × local ship day) makes at
 * most one order — guaranteed by a unique key in the database.
 */
@Injectable()
export class SupplyPlansService {
  private readonly log = new Logger(SupplyPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly orders: OrdersService,
    private readonly hotels: HotelsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // --- reading ------------------------------------------------------------------------------

  /** The hotel's plan (or null) — the hotel must be served by the active site. */
  async get(site: SiteContext, hotelCode: string, now = new Date()): Promise<SupplyPlan | null> {
    const hotel = await this.servedHotel(site, hotelCode);
    const plan = await this.prisma.supplyPlan.findUnique({
      where: { hotelId: hotel.id },
      include: {
        rules: {
          include: { product: { select: { code: true, name: true } } },
          orderBy: { position: 'asc' },
        },
        creator: { select: { displayName: true } },
        updater: { select: { displayName: true } },
        activator: { select: { displayName: true } },
        site: { select: { timeZone: true } },
      },
    });
    if (!plan) return null;
    const today = localDate(now, plan.site.timeZone);
    const rules = plan.rules.map((r) => ({
      productCode: r.product.code,
      productName: r.product.name,
      crates: r.crates,
      days: r.days,
    }));
    const validity = {
      validFrom: iso(plan.validFrom),
      validTo: plan.validTo ? iso(plan.validTo) : null,
    };
    /** Does the current plan still have this day (rules and validity)? */
    const stillPlanned = (day: string) =>
      plannedDays(rules, { from: day, to: day }, validity).days.length > 0;
    const [blocked, orders] = await Promise.all([
      this.prisma.supplyPlanOccurrence.findMany({
        where: { planId: plan.id, status: 'BLOCKED', shipDate: { gte: dateOf(today) } },
        orderBy: { shipDate: 'asc' },
      }),
      this.prisma.supplyPlanOccurrence.findMany({
        where: { planId: plan.id, status: 'ORDERED' },
        include: {
          order: { select: { code: true, status: true, origin: true, requestedShipDate: true } },
        },
        orderBy: { shipDate: 'desc' },
        take: 100,
      }),
    ]);
    return {
      hotel: { code: hotel.code, name: hotel.name },
      status: plan.status as SupplyPlan['status'],
      version: plan.version,
      validFrom: validity.validFrom,
      validTo: validity.validTo,
      rules,
      createdBy: plan.creator.displayName,
      updatedAt: plan.updatedAt.toISOString(),
      updatedBy: plan.updater.displayName,
      activatedAt: plan.activatedAt?.toISOString() ?? null,
      activatedBy: plan.activator?.displayName ?? null,
      lastRunAt: plan.lastRunAt?.toISOString() ?? null,
      lastRunOkAt: plan.lastRunOkAt?.toISOString() ?? null,
      lastRunError: plan.lastRunError,
      nextShipDate: nextPlannedDay(rules, today, validity),
      // Only days the current, switched-on plan still has (an edit or a pause makes older ones moot).
      blocked: blocked
        .filter((b) => plan.status === 'ACTIVE' && stillPlanned(iso(b.shipDate)))
        .map((b) => ({ shipDate: iso(b.shipDate), blockers: [storedBlocker(b)] })),
      orders: orders.map((o) => ({
        code: o.order!.code,
        status: o.order!.status,
        origin: 'SUPPLY_PLAN' as const,
        requestedShipDate: iso(o.order!.requestedShipDate),
        plannedShipDate: iso(o.shipDate),
      })),
    };
  }

  /**
   * What the plan would create in the next 30 days — **writes nothing** (doc 032 §2): per ship
   * day the merged lines with crates and bottles (capacity of the current recipe's crate type),
   * blockers, the hotel's orders already shipping that day, an existing occurrence; skipped days;
   * a summary.
   */
  async preview(
    site: SiteContext,
    hotelCode: string,
    input: SupplyPlanPreviewRequest,
    now = new Date(),
  ): Promise<SupplyPreview> {
    const hotel = await this.servedHotel(site, hotelCode);
    const { timeZone } = await this.prisma.site.findUniqueOrThrow({
      where: { id: site.siteId },
      select: { timeZone: true },
    });
    const today = localDate(now, timeZone);
    const to = addDays(today, SUPPLY_PREVIEW_DAYS - 1);
    const horizonEnd = addDays(today, SUPPLY_HORIZON_DAYS - 1);
    const { days, skipped } = plannedDays(input.rules, { from: today, to }, input);
    const products = await this.productUnits(this.prisma, [
      ...new Set(input.rules.map((r) => r.productCode)),
    ]);
    const siteBlocker = await this.siteBlocker(this.prisma, site.siteId);
    const plan = await this.prisma.supplyPlan.findUnique({
      where: { hotelId: hotel.id },
      select: { id: true },
    });
    const [existing, occurrences] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          hotelId: hotel.id,
          status: { not: 'CANCELLED' },
          requestedShipDate: { gte: dateOf(today), lte: dateOf(to) },
        },
        select: { code: true, status: true, origin: true, requestedShipDate: true },
      }),
      plan
        ? this.prisma.supplyPlanOccurrence.findMany({
            where: { planId: plan.id, shipDate: { gte: dateOf(today), lte: dateOf(to) } },
            include: {
              order: {
                select: { code: true, status: true, origin: true, requestedShipDate: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    const ref = (o: { code: string; status: string; origin: string; requestedShipDate: Date }) => ({
      code: o.code,
      status: o.status as SupplyPreview['days'][number]['existingOrders'][number]['status'],
      origin: (o.origin === 'SUPPLY_PLAN' ? 'SUPPLY_PLAN' : 'MANUAL') as 'SUPPLY_PLAN' | 'MANUAL',
      requestedShipDate: iso(o.requestedShipDate),
    });
    const summary = new Map<
      string,
      { productCode: string; productName: string; crates: number; bottles: number | null }
    >();
    let orders = 0;
    let blockedDays = 0;
    const out = days.map((d) => {
      const lines: SupplyLine[] = d.lines.map((l) => {
        const p = products.get(l.productCode);
        return {
          productCode: l.productCode,
          productName: p?.name ?? l.productCode,
          crates: l.crates,
          crateType: p?.unit?.crateType ?? null,
          capacity: p?.unit?.capacity ?? null,
          bottles: p?.unit ? l.crates * p.unit.capacity : null,
        };
      });
      const blockers: SupplyBlocker[] = [
        ...(siteBlocker ? [{ code: siteBlocker, product: null, detail: null }] : []),
        ...d.lines.flatMap((l): SupplyBlocker[] => {
          const p = products.get(l.productCode);
          if (!p || !p.active) {
            return [{ code: 'UNKNOWN_PRODUCT', product: l.productCode, detail: null }];
          }
          if (!p.unit) {
            return [{ code: 'PRODUCT_WITHOUT_RECIPE', product: l.productCode, detail: null }];
          }
          return [];
        }),
      ];
      const occ = occurrences.find((o) => iso(o.shipDate) === d.shipDate) ?? null;
      if (blockers.length > 0) blockedDays += 1;
      // Not ordered yet (also when an earlier round blocked it and the blocker is gone now).
      else if (!occ || occ.status === 'BLOCKED') {
        orders += 1;
        for (const l of lines) {
          const s = summary.get(l.productCode) ?? {
            productCode: l.productCode,
            productName: l.productName,
            crates: 0,
            bottles: 0,
          };
          s.crates += l.crates;
          s.bottles = s.bottles !== null && l.bottles !== null ? s.bottles + l.bottles : null;
          summary.set(l.productCode, s);
        }
      }
      return {
        shipDate: d.shipDate,
        lines,
        blockers,
        existingOrders: existing.filter((o) => iso(o.requestedShipDate) === d.shipDate).map(ref),
        occurrence: occ
          ? {
              status: occ.status as 'ORDERED' | 'BLOCKED',
              order: occ.order ? ref(occ.order) : null,
            }
          : null,
        inHorizon: d.shipDate <= horizonEnd,
      };
    });
    return {
      from: today,
      to,
      timeZone,
      horizonDays: SUPPLY_HORIZON_DAYS,
      days: out,
      skipped,
      summary: { orders, blocked: blockedDays, products: [...summary.values()] },
    };
  }

  // --- managing -----------------------------------------------------------------------------

  /** Creates the plan (switched off) or saves a new version of it — reason and snapshot audited. */
  async save(actorId: string, site: SiteContext, hotelCode: string, input: SaveSupplyPlanRequest) {
    await this.operations.run(
      'SUPPLY_PLAN_SAVE',
      input.requestId,
      { actorId, siteId: site.siteId, hotelCode, ...input, requestId: undefined },
      async (tx) => {
        const hotel = await this.servedHotel(site, hotelCode, tx);
        await this.lockHotelPlan(tx, hotel.id);
        const products = await this.productUnits(
          tx,
          input.rules.map((r) => r.productCode),
        );
        for (const r of input.rules) {
          const p = products.get(r.productCode);
          if (!p || !p.active) {
            throw domainErrorWithDetails(422, 'UNKNOWN_PRODUCT', 'Unknown or archived product', {
              product: r.productCode,
            });
          }
        }
        const existing = await tx.supplyPlan.findUnique({ where: { hotelId: hotel.id } });
        const plan = existing
          ? await tx.supplyPlan.update({
              where: { id: existing.id },
              data: {
                version: existing.version + 1,
                validFrom: dateOf(input.validFrom),
                validTo: input.validTo ? dateOf(input.validTo) : null,
                updatedAt: new Date(),
                updatedBy: actorId,
              },
            })
          : await tx.supplyPlan.create({
              data: {
                hotelId: hotel.id,
                siteId: site.siteId,
                validFrom: dateOf(input.validFrom),
                validTo: input.validTo ? dateOf(input.validTo) : null,
                createdBy: actorId,
                updatedBy: actorId,
              },
            });
        // The rules are current state; the full snapshot of every version is in the audit.
        await tx.supplyPlanRule.deleteMany({ where: { planId: plan.id } });
        await tx.supplyPlanRule.createMany({
          data: input.rules.map((r, i) => ({
            planId: plan.id,
            position: i + 1,
            productId: products.get(r.productCode)!.id,
            crates: r.crates,
            days: r.days,
          })),
        });
        await this.audit.record(
          {
            type: 'SUPPLY_PLAN_SAVED',
            actorUserId: actorId,
            siteId: site.siteId,
            payload: {
              hotel: hotel.code,
              version: plan.version,
              status: plan.status,
              reason: input.reason,
              validFrom: input.validFrom,
              validTo: input.validTo,
              rules: input.rules,
            },
          },
          tx,
        );
        return { version: plan.version };
      },
    );
    return this.get(site, hotelCode);
  }

  /** Switches the plan on — only with an explicit confirmation; orders follow on the next round. */
  async activate(
    actorId: string,
    site: SiteContext,
    hotelCode: string,
    input: ActivateSupplyPlanRequest,
  ) {
    await this.operations.run(
      'SUPPLY_PLAN_ACTIVATE',
      input.requestId,
      { actorId, siteId: site.siteId, hotelCode, confirm: input.confirm },
      async (tx) => {
        const hotel = await this.servedHotel(site, hotelCode, tx);
        await this.lockHotelPlan(tx, hotel.id);
        const plan = await tx.supplyPlan.findUnique({ where: { hotelId: hotel.id } });
        if (!plan) throw domainError(404, 'NO_SUPPLY_PLAN', 'This hotel has no supply plan');
        if (plan.status === 'ACTIVE') {
          throw domainError(409, 'SUPPLY_PLAN_ACTIVE', 'The supply plan is already switched on');
        }
        const at = new Date();
        await tx.supplyPlan.update({
          where: { id: plan.id },
          data: {
            status: 'ACTIVE',
            activatedAt: at,
            activatedBy: actorId,
            updatedAt: at,
            updatedBy: actorId,
          },
        });
        await this.audit.record(
          {
            type: 'SUPPLY_PLAN_ACTIVATED',
            actorUserId: actorId,
            siteId: site.siteId,
            payload: { hotel: hotel.code, version: plan.version, from: plan.status },
          },
          tx,
        );
        return { ok: true };
      },
    );
    return this.get(site, hotelCode);
  }

  /** Pauses the plan: no new orders; orders already created stay exactly as they are. */
  async pause(
    actorId: string,
    site: SiteContext,
    hotelCode: string,
    input: PauseSupplyPlanRequest,
  ) {
    await this.operations.run(
      'SUPPLY_PLAN_PAUSE',
      input.requestId,
      { actorId, siteId: site.siteId, hotelCode, reason: input.reason },
      async (tx) => {
        const hotel = await this.servedHotel(site, hotelCode, tx);
        await this.lockHotelPlan(tx, hotel.id);
        const plan = await tx.supplyPlan.findUnique({ where: { hotelId: hotel.id } });
        if (!plan) throw domainError(404, 'NO_SUPPLY_PLAN', 'This hotel has no supply plan');
        if (plan.status !== 'ACTIVE') {
          throw domainError(409, 'SUPPLY_PLAN_NOT_ACTIVE', 'Only a switched-on plan is paused');
        }
        await tx.supplyPlan.update({
          where: { id: plan.id },
          data: { status: 'PAUSED', updatedAt: new Date(), updatedBy: actorId },
        });
        await this.audit.record(
          {
            type: 'SUPPLY_PLAN_PAUSED',
            actorUserId: actorId,
            siteId: site.siteId,
            payload: { hotel: hotel.code, version: plan.version, reason: input.reason },
          },
          tx,
        );
        return { ok: true };
      },
    );
    return this.get(site, hotelCode);
  }

  // --- generating ---------------------------------------------------------------------------

  /** One background round: every switched-on plan (all sites). */
  async runDue(now = new Date()): Promise<void> {
    const plans = await this.prisma.supplyPlan.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const p of plans) {
      try {
        await this.generate(p.id, now);
      } catch (error) {
        this.log.warn(`Supply plan ${p.id} failed: ${String(error)}`);
      }
    }
  }

  /**
   * Creates the missing orders of one plan for the horizon (today and the next 13 local days of
   * the serving site; never a past day). Each occurrence in its own transaction, serialised per
   * plan (row lock); its order and occurrence are written together or not at all. A blocked
   * occurrence records its reason and is tried again on later rounds.
   */
  async generate(planId: string, now = new Date()): Promise<{ created: number; blocked: number }> {
    const plan = await this.prisma.supplyPlan.findUniqueOrThrow({
      where: { id: planId },
      include: {
        hotel: { select: { code: true } },
        site: { select: { timeZone: true } },
        rules: { include: { product: { select: { code: true } } }, orderBy: { position: 'asc' } },
      },
    });
    let created = 0;
    let blocked = 0;
    let failure: string | null = null;
    if (plan.status === 'ACTIVE') {
      const today = localDate(now, plan.site.timeZone);
      const rules: CalendarRule[] = plan.rules.map((r) => ({
        productCode: r.product.code,
        crates: r.crates,
        days: r.days,
      }));
      const { days } = plannedDays(
        rules,
        { from: today, to: addDays(today, SUPPLY_HORIZON_DAYS - 1) },
        { validFrom: iso(plan.validFrom), validTo: plan.validTo ? iso(plan.validTo) : null },
      );
      for (const day of days) {
        try {
          const outcome = await this.occurrence(planId, plan.version, day.shipDate, day.lines);
          if (outcome === 'CREATED') created += 1;
          if (outcome === 'BLOCKED') blocked += 1;
          if (outcome === 'STOPPED') break;
        } catch (error) {
          failure = 'Vyhodnocení plánu se nepodařilo dokončit – zkusí se znovu v dalším kole';
          this.log.warn(`Supply plan ${planId} ${day.shipDate}: ${String(error)}`);
          break;
        }
      }
    }
    await this.prisma.supplyPlan.update({
      where: { id: planId },
      data: {
        lastRunAt: now,
        ...(failure ? { lastRunError: failure } : { lastRunOkAt: now, lastRunError: null }),
      },
    });
    return { created, blocked };
  }

  private async occurrence(
    planId: string,
    /** The version this round read its rules from: a newer one stops the round (next round). */
    version: number,
    shipDate: string,
    lines: { productCode: string; crates: number }[],
  ): Promise<'CREATED' | 'EXISTS' | 'BLOCKED' | 'STOPPED'> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Serialised per plan: concurrent rounds, a restart or a manual pause queue here.
          const [plan] = await tx.$queryRaw<
            {
              id: string;
              status: string;
              version: number;
              activated_by: string | null;
              site_id: string;
            }[]
          >`SELECT "id", "status", "version", "activated_by", "site_id" FROM "supply_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
          if (!plan || plan.status !== 'ACTIVE' || !plan.activated_by) return 'STOPPED' as const;
          // Saved anew meanwhile: these lines may be stale — the next round uses the new version.
          if (plan.version !== version) return 'STOPPED' as const;
          // An inactive site is its own, visible reason (the order rules would say "no warehouse").
          if ((await this.siteBlocker(tx, plan.site_id)) === 'SITE_INACTIVE') {
            throw domainError(409, 'SITE_INACTIVE', 'The serving site is not active');
          }
          const existing = await tx.supplyPlanOccurrence.findUnique({
            where: { planId_shipDate: { planId, shipDate: dateOf(shipDate) } },
          });
          // Ordered once — also when that order was later cancelled or moved: never again.
          if (existing?.status === 'ORDERED') return 'EXISTS' as const;
          const hotel = await tx.supplyPlan.findUniqueOrThrow({
            where: { id: planId },
            select: { hotel: { select: { code: true } } },
          });
          const occurrenceId = existing?.id ?? randomUUID();
          const operationRequestId = derivedRequestId(planId, `occurrence:${shipDate}`);
          await tx.operationRequest.create({
            data: {
              requestId: operationRequestId,
              kind: 'SUPPLY_PLAN_ORDER',
              payloadSha256: payloadHash('SUPPLY_PLAN_ORDER', { planId, shipDate }),
            },
          });
          const order = await this.orders.insertOrder(tx, {
            actorId: plan.activated_by,
            siteId: plan.site_id,
            hotelCode: hotel.hotel.code,
            requestedShipDate: shipDate,
            lines,
            operationRequestId,
            origin: { occurrenceId, plan: hotel.hotel.code, plannedShipDate: shipDate },
          });
          const snapshot = await this.snapshot(tx, order.id);
          if (existing) {
            await tx.supplyPlanOccurrence.update({
              where: { id: existing.id },
              data: {
                status: 'ORDERED',
                orderId: order.id,
                planVersion: plan.version,
                snapshot,
                blockedCode: null,
                blockedDetail: null,
                updatedAt: new Date(),
              },
            });
          } else {
            await tx.supplyPlanOccurrence.create({
              data: {
                id: occurrenceId,
                planId,
                shipDate: dateOf(shipDate),
                status: 'ORDERED',
                orderId: order.id,
                planVersion: plan.version,
                snapshot,
              },
            });
          }
          await this.audit.record(
            {
              type: 'SUPPLY_PLAN_ORDER_CREATED',
              actorUserId: null,
              siteId: plan.site_id,
              payload: {
                hotel: hotel.hotel.code,
                shipDate,
                order: order.code,
                planVersion: plan.version,
              },
            },
            tx,
          );
          await tx.operationRequest.update({
            where: { requestId: operationRequestId },
            data: { result: { order: order.code } },
          });
          return 'CREATED' as const;
        },
        { maxWait: 20_000, timeout: 30_000 },
      );
    } catch (error) {
      // Another round created it in the meantime (unique key): nothing to do.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'EXISTS';
      }
      // The day became past during the round (midnight at the site): never a past order.
      if (codeOf(error) === 'SHIP_DATE_IN_PAST') return 'EXISTS';
      const blocker = blockerOf(error);
      if (!blocker) throw error;
      await this.block(planId, shipDate, lines, blocker);
      return 'BLOCKED';
    }
  }

  /** A visible reason instead of a partial order; tried again on the next rounds. */
  private async block(
    planId: string,
    shipDate: string,
    lines: { productCode: string; crates: number }[],
    blocker: SupplyBlocker,
  ): Promise<void> {
    const plan = await this.prisma.supplyPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { version: true },
    });
    const snapshot = JSON.stringify({ lines });
    await this.prisma.$executeRaw`
      INSERT INTO "supply_plan_occurrences"
        ("plan_id", "ship_date", "status", "plan_version", "snapshot", "blocked_code", "blocked_detail")
      VALUES (${planId}::uuid, ${shipDate}::date, 'BLOCKED', ${plan.version}, ${snapshot}::jsonb,
              ${blocker.code}, ${blocker.code === 'ORDER_REFUSED' ? blocker.detail : blocker.product})
      ON CONFLICT ("plan_id", "ship_date") DO UPDATE
        SET "plan_version" = EXCLUDED."plan_version", "snapshot" = EXCLUDED."snapshot",
            "blocked_code" = EXCLUDED."blocked_code", "blocked_detail" = EXCLUDED."blocked_detail",
            "updated_at" = now()
        WHERE "supply_plan_occurrences"."status" = 'BLOCKED'`;
  }

  /** What was ordered for the occurrence (kept with it): lines as the order has them. */
  private async snapshot(tx: Tx, orderId: string): Promise<Prisma.InputJsonValue> {
    const lines = await tx.orderLine.findMany({
      where: { orderId },
      include: {
        product: { select: { code: true, name: true } },
        crateType: { select: { code: true } },
      },
      orderBy: { lineNo: 'asc' },
    });
    return {
      lines: lines.map((l) => ({
        productCode: l.product.code,
        productName: l.product.name,
        crates: l.crates,
        crateType: l.crateType.code,
        capacity: l.capacity,
        bottles: l.bottles,
      })),
    };
  }

  // --- helpers ------------------------------------------------------------------------------

  /** The hotel by code, served by the active site (a plan and its orders belong to that site). */
  private async servedHotel(site: SiteContext, code: string, db: Tx = this.prisma) {
    const hotel = await this.hotels.byCode(code, db);
    if (!hotel) throw new NotFoundException('Hotel not found');
    if (hotel.fulfillmentSiteId !== site.siteId) {
      throw domainErrorWithDetails(
        409,
        'HOTEL_OF_ANOTHER_SITE',
        'This hotel is served by another site',
        {
          site: hotel.fulfillmentSite.code,
        },
      );
    }
    return hotel;
  }

  /**
   * Serialises the management of one hotel's plan (also its creation, when no plan row exists
   * yet) with a transaction-scoped advisory lock — never a lock on the hotel row, which a round
   * creating an order needs for its foreign key (the order of locks would deadlock).
   */
  private async lockHotelPlan(tx: Tx, hotelId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`supply-plan:${hotelId}`}, 0))`;
    await tx.$executeRaw`SELECT 1 FROM "supply_plans" WHERE "hotel_id" = ${hotelId}::uuid FOR UPDATE`;
  }

  private async productUnits(db: Tx, codes: string[]) {
    const rows = await db.product.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true, name: true, status: true },
    });
    const out = new Map<
      string,
      {
        id: string;
        name: string;
        active: boolean;
        unit: { crateType: string; capacity: number } | null;
      }
    >();
    for (const r of rows) {
      const unit = r.status === 'ACTIVE' ? await this.orders.crateUnitOf(db, r.id) : null;
      out.set(r.code, {
        id: r.id,
        name: r.name,
        active: r.status === 'ACTIVE',
        unit: unit ? { crateType: unit.view.crateType.code, capacity: unit.view.capacity } : null,
      });
    }
    return out;
  }

  private async siteBlocker(db: Tx, siteId: string): Promise<SupplyBlocker['code'] | null> {
    const s = await db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { active: true, _count: { select: { locations: true } } },
    });
    if (!s.active) return 'SITE_INACTIVE';
    return s._count.locations === 0 ? 'SITE_WITHOUT_WAREHOUSE' : null;
  }
}

/** The order rules' refusal as a blocker (other errors are failures of the round, not blockers). */
function codeOf(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  return (error.getResponse() as { code?: string })?.code ?? null;
}

/**
 * A refusal of the order rules as a visible blocker of that day — a known one by its own code,
 * any other refusal as ORDER_REFUSED with that code (never a silent stop of the whole plan).
 * Database or connection errors are not refusals: the round fails and tries again later.
 */
function blockerOf(error: unknown): SupplyBlocker | null {
  if (!(error instanceof HttpException)) {
    // A database rule refusing the order (e.g. the site lost its WAREHOUSE capability).
    const message = error instanceof Error ? error.message : '';
    const rule = /AYVO: ([^\n]{1,200})/.exec(message);
    return rule ? { code: 'ORDER_REFUSED', product: null, detail: rule[1]!.trim() } : null;
  }
  const body = error.getResponse() as { code?: string; details?: { product?: string } };
  if (!body?.code) return null;
  const known = BLOCKER_CODES.has(body.code as SupplyBlocker['code']);
  return known
    ? {
        code: body.code as SupplyBlocker['code'],
        product: body.details?.product ?? null,
        detail: null,
      }
    : { code: 'ORDER_REFUSED', product: null, detail: body.code };
}

/** A stored blocked occurrence as its blocker (ORDER_REFUSED keeps its detail, others a product). */
function storedBlocker(b: {
  blockedCode: string | null;
  blockedDetail: string | null;
}): SupplyBlocker {
  const code = b.blockedCode as SupplyBlocker['code'];
  return code === 'ORDER_REFUSED'
    ? { code, product: null, detail: b.blockedDetail }
    : { code, product: b.blockedDetail, detail: null };
}
