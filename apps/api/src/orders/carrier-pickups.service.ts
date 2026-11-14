import { randomBytes } from 'node:crypto';
import type {
  LookupPickupRequest,
  OrderPickupRequest,
  PickupBoard,
  PickupCandidate,
  PickupView,
  ResolvePickupRequest,
} from '@ayvo/types';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CARRIERS,
  CarrierRejectedError,
  type CarrierGateway,
  type CarrierPickupOutcome,
  type CarrierPickupRequest,
  type CarrierRegistry,
} from '../carriers/carrier.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { localDate } from './orders.service.js';

type Tx = Prisma.TransactionClient;

/** The error code of a call (or lookup) whose outcome is unknown (never re-sent). */
export const PICKUP_NO_ANSWER = 'NO_ANSWER';
/** Bounded automatic lookups of an accepted pickup (back-off 10 s … 5 min, in SQL). */
export const PICKUP_MAX_POLLS = 30;
const LEASE_SECONDS = 60;
const RECENT = 20;
const UNRESOLVED = ['PREPARED', 'SENT', 'ACCEPTED'] as const;

const notFound = () => new NotFoundException('Pickup not found');

const pickupInclude = {
  orders: {
    include: {
      order: { select: { serial: true, hotelName: true, status: true } },
      shipment: { select: { code: true } },
    },
  },
} satisfies Prisma.CarrierPickupInclude;
type PickupRow = Prisma.CarrierPickupGetPayload<{ include: typeof pickupInclude }>;

/**
 * Pickup orders at the carrier — "svoz" (doc 029 §11). One explicit "Objednat svoz" of the active
 * site writes the pickup (PREPARED) with its planned orders in one transaction, then sends it ONCE
 * (claimed PREPARED → SENT first, outside any transaction, with a time limit). An accepted pickup
 * is looked up (bounded, state in the database); a lost answer stays SENT — uncertain — and is
 * only looked up by its own reference, never sent again; a new pickup of the site waits until it
 * is resolved (also a database rule). Confirmed only by the carrier's answer. A pickup never
 * changes an order or a shipment, and never confirms a hand-over: that stays the carrier's
 * tracking per parcel (doc 031) or the manual "Předáno dopravci".
 */
@Injectable()
export class CarrierPickupsService {
  private readonly log = new Logger(CarrierPickupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    @Inject(CARRIERS) private readonly carriers: CarrierRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** A carrier call with a hard time limit: an expired call is an unknown outcome. */
  private async call<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.env.CARRIER_CALL_TIMEOUT_SECONDS * 1000,
    );
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- reading -------------------------------------------------------------------------------

  /** "Připravené ke svozu": the labelled orders ready for pickup, the open and recent pickups. */
  async board(site: SiteContext): Promise<PickupBoard> {
    const today = await this.today(site.siteId);
    const choice = await this.carriers.forSite(site.siteId);
    const gateway = choice.gateway;
    const pickups = gateway?.pickups ?? null;
    const sender = choice.gateway ? choice.settings.sender : null;
    const orders = await this.prisma.order.findMany({
      where: { siteId: site.siteId, status: 'READY_FOR_PICKUP' },
      orderBy: [{ requestedShipDate: 'asc' }, { serial: 'asc' }],
      select: {
        id: true,
        serial: true,
        hotelName: true,
        city: true,
        requestedShipDate: true,
        shipments: {
          where: { status: 'LABELED' },
          select: {
            code: true,
            carrierCode: true,
            carrierConnection: true,
            carrierEnvironment: true,
            carrierAccount: true,
            _count: { select: { parcels: true } },
          },
        },
      },
    });
    const planned = await this.plannedOrders(
      this.prisma,
      orders.map((o) => o.id),
      today,
    );
    const candidates: PickupCandidate[] = orders.flatMap((o) => {
      const s = o.shipments[0];
      if (!s) return [];
      const inPickup = planned.get(o.id) ?? null;
      const sameCarrier = !!gateway && sameConnection(s, gateway);
      return [
        {
          orderCode: formatCode(CODE_PREFIX.order, o.serial),
          shipmentCode: s.code,
          hotelName: o.hotelName,
          city: o.city,
          requestedShipDate: o.requestedShipDate.toISOString().slice(0, 10),
          parcelCount: s._count.parcels,
          eligible: !inPickup && sameCarrier && !!pickups,
          blockedBy: inPickup ? 'IN_PICKUP' : sameCarrier ? null : 'OTHER_CARRIER',
          pickupCode: inPickup,
        },
      ];
    });
    const rows = await this.prisma.carrierPickup.findMany({
      where: { siteId: site.siteId },
      orderBy: { serial: 'desc' },
      take: RECENT,
      include: pickupInclude,
    });
    const open = rows.find((r) => (UNRESOLVED as readonly string[]).includes(r.status)) ?? null;
    return {
      today,
      carrier: {
        available: !!pickups,
        reason: choice.gateway ? (pickups ? null : 'PICKUP_UNSUPPORTED') : choice.reason,
        code: gateway?.code ?? null,
        name: gateway?.name ?? null,
        environment: gateway?.environment ?? null,
        maxParcels: pickups?.maxParcels ?? null,
        sender: sender
          ? {
              name: sender.name,
              street: [sender.addressLine1, sender.addressLine2].filter(Boolean).join(', '),
              city: sender.city,
              postalCode: sender.postalCode,
              country: sender.countryCode,
            }
          : null,
      },
      candidates,
      open: open ? this.toView(open) : null,
      pickups: rows.map((r) => this.toView(r)),
    };
  }

  async view(site: SiteContext, code: string): Promise<PickupView> {
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    return this.toView(row);
  }

  // --- ordering ------------------------------------------------------------------------------

  /**
   * "Objednat svoz PPL": one pickup of the active site for the selected orders (all of them
   * ready for pickup, labelled with the site's current carrier connection, environment and
   * account), the stated day and optional window, announcing their parcels. A repeated click
   * (same request id) returns the same pickup and sends nothing again; another request while a
   * pickup of the site waits for the carrier is refused (also by the database).
   */
  async order(actorId: string, site: SiteContext, input: OrderPickupRequest): Promise<PickupView> {
    const choice = await this.carriers.forSite(site.siteId);
    const orderCodes = [...input.orders].sort();
    const { result } = await this.operations.run<{ id: string; code: string }>(
      'CARRIER_PICKUP_ORDER',
      input.requestId,
      { actorId, siteId: site.siteId, date: input.date, window: input.window, orders: orderCodes },
      async (tx) => {
        // One pickup decision per site at a time (the unresolved check below and the database
        // rule then hold against concurrent requests).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`carrier_pickup:${site.siteId}`}, 0))`;
        if (!choice.gateway) {
          throw domainErrorWithDetails(409, 'CARRIER_NOT_CONFIGURED', 'No carrier at this site', {
            reason: choice.reason,
          });
        }
        const gateway = choice.gateway;
        const pickups = gateway.pickups;
        if (!pickups) {
          throw domainError(409, 'PICKUP_UNSUPPORTED', 'This carrier takes no pickup orders');
        }
        const open = await tx.carrierPickup.findFirst({
          where: { siteId: site.siteId, status: { in: [...UNRESOLVED] } },
          select: { code: true },
        });
        if (open) {
          throw domainErrorWithDetails(
            409,
            'PICKUP_IN_PROGRESS',
            'A pickup of this site still waits for the carrier',
            { pickup: open.code },
          );
        }
        const today = await this.today(site.siteId, tx);
        if (input.date < today) {
          throw domainErrorWithDetails(422, 'PICKUP_DATE_PAST', 'The pickup day has passed', {
            today,
          });
        }
        // The pickup is collected at the sender address (PPL: the registered one).
        if (gateway.rules.senderAddress === 'REQUIRED' && !choice.settings.sender) {
          throw domainError(422, 'PICKUP_SENDER_MISSING', 'The site has no sender address');
        }
        const plan: { orderId: string; shipmentId: string; parcelCount: number }[] = [];
        for (const code of orderCodes) {
          const serial = parseCodeSerial(CODE_PREFIX.order, code);
          const found =
            serial === null
              ? null
              : await tx.order.findFirst({
                  where: { serial, siteId: site.siteId },
                  select: { id: true },
                });
          // Another site's order does not exist here.
          if (!found) {
            throw domainErrorWithDetails(404, 'ORDER_NOT_FOUND', 'Order not found', {
              order: code,
            });
          }
          await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
          const order = await tx.order.findUniqueOrThrow({
            where: { id: found.id },
            select: { id: true, status: true },
          });
          const shipment = await tx.shipment.findFirst({
            where: { orderId: order.id, status: 'LABELED' },
            select: {
              id: true,
              carrierCode: true,
              carrierConnection: true,
              carrierEnvironment: true,
              carrierAccount: true,
              _count: { select: { parcels: true } },
            },
          });
          if (order.status !== 'READY_FOR_PICKUP' || !shipment) {
            throw domainErrorWithDetails(
              409,
              'ORDER_NOT_READY_FOR_PICKUP',
              'Only a labelled order ready for pickup is planned for a pickup',
              { order: code, status: order.status },
            );
          }
          if (!sameConnection(shipment, gateway)) {
            throw domainErrorWithDetails(
              409,
              'PICKUP_OTHER_CARRIER',
              'The order was labelled with another carrier connection, environment or account',
              { order: code },
            );
          }
          plan.push({
            orderId: order.id,
            shipmentId: shipment.id,
            parcelCount: shipment._count.parcels,
          });
        }
        const inPickup = await this.plannedOrders(
          tx,
          plan.map((p) => p.orderId),
          today,
        );
        if (inPickup.size > 0) {
          throw domainErrorWithDetails(
            409,
            'ORDER_IN_PICKUP',
            'An order is already planned for a pending or coming pickup',
            { pickups: [...new Set(inPickup.values())] },
          );
        }
        const parcelCount = plan.reduce((n, p) => n + p.parcelCount, 0);
        if (parcelCount > pickups.maxParcels) {
          throw domainErrorWithDetails(
            422,
            'PICKUP_TOO_LARGE',
            'The carrier takes fewer parcels in one pickup order',
            { parcelCount, maxParcels: pickups.maxParcels },
          );
        }
        const { first: serial } = await allocateSerials(tx, 'carrier_pickup', 1);
        const code = formatCode(CODE_PREFIX.carrierPickup, serial);
        // Unique at the carrier, also across AYVO environments sharing one carrier account.
        const clientReference = `${code}-${randomBytes(4).toString('hex')}`;
        const payload: CarrierPickupRequest = {
          clientReference,
          pickupCode: code,
          date: input.date,
          window: input.window,
          parcelCount,
          settings: choice.settings,
        };
        const pickup = await tx.carrierPickup.create({
          data: {
            serial,
            code,
            siteId: site.siteId,
            carrierCode: gateway.code,
            carrierConnection: gateway.connection,
            carrierEnvironment: gateway.environment,
            carrierAccount: gateway.account,
            clientReference,
            pickupDate: new Date(`${input.date}T00:00:00Z`),
            windowFrom: input.window?.from ?? null,
            windowTo: input.window?.to ?? null,
            parcelCount,
            payload: JSON.parse(JSON.stringify(payload)),
            createdAt: new Date(),
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
          select: { id: true, code: true },
        });
        await tx.carrierPickupOrder.createMany({
          data: plan.map((p) => ({ pickupId: pickup.id, ...p })),
        });
        return { id: pickup.id, code: pickup.code };
      },
    );
    // Sent after the commit; a replay drives the same pickup (PREPARED is claimed only once).
    await this.drive(result.id);
    return this.view(site, result.code);
  }

  /**
   * "Zjistit stav u dopravce": a read-only lookup of an accepted pickup, of an uncertain one (its
   * answer lost — only after the in-flight window, by its own reference), or of a confirmed one
   * still without the carrier's number. Never sends the pickup again.
   */
  async lookup(site: SiteContext, code: string, input: LookupPickupRequest): Promise<PickupView> {
    void input;
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    if (row.status === 'SENT' && !(await this.settled(row.id))) {
      throw domainError(409, 'PICKUP_IN_FLIGHT', 'The carrier may still be answering');
    }
    await this.drive(row.id, true);
    return this.view(site, code);
  }

  /**
   * The exceptional closing of an uncertain pickup (SENT, its answer lost): only after the
   * in-flight window, after one more lookup that does not find it, and only by a person who
   * checked with the carrier that it was not ordered (`shipments:resolve_uncertain`, reason
   * recorded). The site can then order a new pickup; this one is never sent again.
   */
  async resolve(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ResolvePickupRequest,
  ): Promise<PickupView> {
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    if (row.status === 'SENT') {
      if (!(await this.settled(row.id))) {
        throw domainError(409, 'PICKUP_IN_FLIGHT', 'The carrier may still be answering');
      }
      // The carrier's own answer first: found = confirmed, never closed by a person.
      await this.drive(row.id, true);
    }
    await this.operations.run(
      'CARRIER_PICKUP_RESOLVE',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        const closed = await tx.$executeRaw`
          UPDATE "carrier_pickups"
             SET "status" = 'NOT_CREATED', "resolved_at" = now(), "resolved_by" = ${actorId}::uuid,
                 "resolution_reason" = ${input.reason}
           WHERE "id" = ${row.id}::uuid AND "status" = 'SENT'`;
        if (closed !== 1) {
          const now = await tx.carrierPickup.findUniqueOrThrow({
            where: { id: row.id },
            select: { status: true },
          });
          throw domainErrorWithDetails(
            409,
            'PICKUP_NOT_UNCERTAIN',
            'Only an uncertain pickup is closed by a person',
            { status: now.status },
          );
        }
        return { code };
      },
    );
    return this.view(site, code);
  }

  // --- talking to the carrier ----------------------------------------------------------------

  /** Moves one pickup forward (see {@link order}, {@link lookup}). */
  async drive(id: string, lookup = false): Promise<void> {
    const p = await this.prisma.carrierPickup.findUniqueOrThrow({ where: { id } });
    const gateway = await this.carriers.forConnection({
      carrierCode: p.carrierCode,
      connection: p.carrierConnection,
      environment: p.carrierEnvironment,
      account: p.carrierAccount,
    });
    // Only its own connection, environment and account — never a fallback.
    const pickups = gateway?.pickups;
    if (!pickups) return;
    if (p.status === 'PREPARED') {
      const claimed = await this.prisma.$executeRaw`
        UPDATE "carrier_pickups" SET "status" = 'SENT', "sent_at" = now()
         WHERE "id" = ${id}::uuid AND "status" = 'PREPARED'`;
      if (claimed !== 1) return; // someone else is sending it
      let outcome: CarrierPickupOutcome;
      try {
        outcome = await this.call((signal) =>
          pickups.order(p.payload as unknown as CarrierPickupRequest, signal),
        );
      } catch (error) {
        if (error instanceof CarrierRejectedError) {
          outcome = { kind: 'REJECTED', code: error.code, message: error.message };
        } else {
          this.log.warn(`Pickup ${p.code}: no usable answer from the carrier`);
          outcome = { kind: 'UNKNOWN', detail: 'The carrier did not answer usably' };
        }
      }
      await this.settle(id, outcome);
      return;
    }
    const look =
      p.status === 'ACCEPTED' ||
      (lookup && p.status === 'SENT') ||
      (lookup && p.status === 'CONFIRMED' && p.carrierOrderNumber === null);
    if (!look) return;
    let outcome: CarrierPickupOutcome;
    try {
      outcome = await this.call((signal) =>
        pickups.status({ clientReference: p.clientReference, carrierRef: p.carrierRef }, signal),
      );
    } catch {
      this.log.warn(`Pickup ${p.code}: lookup failed`);
      outcome = { kind: 'UNKNOWN', detail: 'The carrier could not be asked' };
    }
    await this.settle(id, outcome);
  }

  private async settle(id: string, outcome: CarrierPickupOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'ACCEPTED': {
        const moved = await this.prisma.$executeRaw`
          UPDATE "carrier_pickups"
             SET "status" = 'ACCEPTED', "carrier_ref" = ${outcome.carrierRef},
                 "error_code" = NULL, "error_message" = NULL,
                 "next_poll_at" = now() + make_interval(secs => ${LEASE_SECONDS}), "poll_count" = 0
           WHERE "id" = ${id}::uuid AND "status" = 'SENT'`;
        // One immediate look; still processing later = looked up again by the poller.
        if (moved === 1) await this.drive(id);
        return;
      }
      case 'PENDING':
        await this.schedule(id);
        return;
      case 'CONFIRMED': {
        const number = outcome.orderNumber?.slice(0, 100) ?? null;
        const state = outcome.state?.slice(0, 100) ?? null;
        const moved = await this.prisma.$executeRaw`
          UPDATE "carrier_pickups"
             SET "status" = 'CONFIRMED', "resolved_at" = now(), "next_poll_at" = NULL,
                 "error_code" = NULL, "error_message" = NULL,
                 "carrier_order_number" = ${number}, "carrier_state" = ${state}
           WHERE "id" = ${id}::uuid AND "status" IN ('SENT', 'ACCEPTED')`;
        if (moved === 0 && number !== null) {
          // Confirmed before without the carrier's number: it only learns it now.
          await this.prisma.$executeRaw`
            UPDATE "carrier_pickups"
               SET "carrier_order_number" = ${number}, "carrier_state" = ${state}
             WHERE "id" = ${id}::uuid AND "status" = 'CONFIRMED' AND "carrier_order_number" IS NULL`;
        }
        return;
      }
      case 'REJECTED': {
        const moved = await this.prisma.$executeRaw`
          UPDATE "carrier_pickups"
             SET "status" = 'REJECTED', "resolved_at" = now(), "next_poll_at" = NULL,
                 "error_code" = ${outcome.code.slice(0, 100)},
                 "error_message" = ${outcome.message.slice(0, 1000)}
           WHERE "id" = ${id}::uuid AND "status" IN ('SENT', 'ACCEPTED')`;
        if (moved === 0) this.log.error(`Pickup ${id}: refused after it was resolved`);
        return;
      }
      case 'UNKNOWN': {
        // Uncertain stays uncertain (SENT, looked up by a person); accepted is looked up again.
        await this.prisma.$executeRaw`
          UPDATE "carrier_pickups"
             SET "error_code" = CASE WHEN "status" = 'SENT' THEN ${PICKUP_NO_ANSWER} ELSE "error_code" END,
                 "error_message" = ${outcome.detail.slice(0, 1000)}
           WHERE "id" = ${id}::uuid AND "status" IN ('SENT', 'ACCEPTED')`;
        await this.schedule(id);
        return;
      }
    }
  }

  /** The next automatic look of an accepted pickup (bounded, back-off, database time). */
  private async schedule(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "carrier_pickups"
         SET "poll_count" = "poll_count" + 1,
             "next_poll_at" = CASE WHEN "poll_count" + 1 >= ${PICKUP_MAX_POLLS} THEN NULL
                                   ELSE now() + make_interval(secs => LEAST(5 * power(2, "poll_count" + 1), 300)) END
       WHERE "id" = ${id}::uuid AND "status" = 'ACCEPTED'`;
  }

  /** Background lookups of accepted pickups (several API processes share them: SKIP LOCKED). */
  async pollDue(limit = 5): Promise<number> {
    const due = await this.prisma.$queryRaw<{ id: string; lease: Date }[]>`
      UPDATE "carrier_pickups" p
         SET "next_poll_at" = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE p."id" IN (SELECT q."id" FROM "carrier_pickups" q
                         WHERE q."status" = 'ACCEPTED' AND q."next_poll_at" <= now()
                         ORDER BY q."next_poll_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING p."id", p."next_poll_at" AS "lease"`;
    for (const r of due) {
      try {
        await this.drive(r.id);
      } catch (error) {
        this.log.warn(`Pickup lookup ${r.id} failed: ${String(error)}`);
      }
      // Untouched by the round: counted, so the lookups stay bounded.
      const untouched = await this.prisma.carrierPickup.count({
        where: { id: r.id, nextPollAt: r.lease, status: 'ACCEPTED' },
      });
      if (untouched) await this.schedule(r.id);
    }
    return due.length;
  }

  // --- helpers -------------------------------------------------------------------------------

  /**
   * Orders already planned in a pickup that waits for the carrier, or that is confirmed for today
   * or later (order id → pickup code). A past confirmed pickup does not block: what it did not
   * collect is planned again.
   */
  private async plannedOrders(db: Tx, orderIds: string[], today: string) {
    if (orderIds.length === 0) return new Map<string, string>();
    const rows = await db.carrierPickupOrder.findMany({
      where: {
        orderId: { in: orderIds },
        pickup: {
          OR: [
            { status: { in: [...UNRESOLVED] } },
            { status: 'CONFIRMED', pickupDate: { gte: new Date(`${today}T00:00:00Z`) } },
          ],
        },
      },
      select: { orderId: true, pickup: { select: { code: true } } },
    });
    return new Map(rows.map((r) => [r.orderId, r.pickup.code]));
  }

  private async settled(id: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<{ settled: boolean }[]>`
      SELECT ("sent_at" + make_interval(secs => ${this.env.CARRIER_SETTLE_SECONDS})) <= now() AS settled
        FROM "carrier_pickups" WHERE "id" = ${id}::uuid`;
    return row?.settled ?? false;
  }

  private find(db: Tx, siteId: string, code: string): Promise<PickupRow | null> {
    const serial = parseCodeSerial(CODE_PREFIX.carrierPickup, code);
    if (serial === null) return Promise.resolve(null);
    return db.carrierPickup.findFirst({ where: { serial, siteId }, include: pickupInclude });
  }

  private async today(siteId: string, db: Tx = this.prisma): Promise<string> {
    const { timeZone } = await db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { timeZone: true },
    });
    return localDate(new Date(), timeZone);
  }

  private toView(r: PickupRow): PickupView {
    return {
      code: r.code,
      status: r.status,
      date: r.pickupDate.toISOString().slice(0, 10),
      window: r.windowFrom && r.windowTo ? { from: r.windowFrom, to: r.windowTo } : null,
      parcelCount: r.parcelCount,
      carrier: {
        code: r.carrierCode,
        environment: r.carrierEnvironment === 'PRODUCTION' ? 'PRODUCTION' : 'TEST',
      },
      carrierOrderNumber: r.carrierOrderNumber,
      carrierState: r.carrierState,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionReason: r.resolutionReason,
      lookupFrom:
        r.status === 'SENT' && r.sentAt
          ? new Date(r.sentAt.getTime() + this.env.CARRIER_SETTLE_SECONDS * 1000).toISOString()
          : null,
      orders: r.orders
        .map((o) => ({
          orderCode: formatCode(CODE_PREFIX.order, o.order.serial),
          shipmentCode: o.shipment.code,
          hotelName: o.order.hotelName,
          parcelCount: o.parcelCount,
          orderStatus: o.order.status,
        }))
        .sort((a, b) => a.orderCode.localeCompare(b.orderCode)),
    };
  }
}

function sameConnection(
  s: {
    carrierCode: string | null;
    carrierConnection: string | null;
    carrierEnvironment: string | null;
    carrierAccount: string | null;
  },
  g: CarrierGateway,
): boolean {
  return (
    s.carrierCode === g.code &&
    s.carrierConnection === g.connection &&
    s.carrierEnvironment === g.environment &&
    s.carrierAccount === g.account
  );
}
