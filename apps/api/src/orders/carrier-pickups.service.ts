import { randomBytes } from 'node:crypto';
import type {
  CancelPickupRequest,
  LookupPickupRequest,
  OrderPickupRequest,
  PickupBoard,
  PickupCandidate,
  PickupView,
  ResolvePickupCancelRequest,
  ResolvePickupRequest,
} from '@ayvo/types';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CARRIERS,
  CarrierRejectedError,
  type CarrierGateway,
  type CarrierPickupOutcome,
  type CarrierPickupRequest,
  type CarrierPickups,
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
/** Bounded automatic lookups of an accepted pickup or cancellation (back-off 10 s … 5 min). */
export const PICKUP_MAX_POLLS = 30;
const LEASE_SECONDS = 60;
const RECENT = 20;
const UNRESOLVED = ['PREPARED', 'SENT', 'ACCEPTED'] as const;

const notFound = () => new NotFoundException('Pickup not found');

const pickupInclude = {
  parcels: {
    include: {
      order: { select: { serial: true, hotelName: true, status: true } },
      shipment: { select: { code: true } },
      parcel: { select: { parcelNo: true, progress: { select: { pickedUpSource: true } } } },
    },
  },
  cancellations: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.CarrierPickupInclude;
type PickupRow = Prisma.CarrierPickupGetPayload<{ include: typeof pickupInclude }>;

/**
 * Where a parcel's plan still holds it: a pickup that waits for the carrier (pending or
 * uncertain); a confirmed one whose cancellation is not resolved (whatever its day — a new one
 * starts only up to the pickup's day, under the site's pickup lock, see {@link CarrierPickupsService.cancel});
 * a confirmed one for today or later. A confirmed past pickup, a refused, closed or unsent one, or
 * one the carrier shows cancelled releases it (planned again with the same labels).
 */
const holding = (today: string): Prisma.CarrierPickupWhereInput => ({
  carrierCancelledAt: null,
  OR: [
    { status: { in: [...UNRESOLVED] } },
    { status: 'CONFIRMED', cancellations: { some: { status: { in: [...UNRESOLVED] } } } },
    { status: 'CONFIRMED', pickupDate: { gte: new Date(`${today}T00:00:00Z`) } },
  ],
});

/**
 * Pickup orders at the carrier — "svoz" (doc 029 §11). One explicit "Objednat svoz" of the active
 * site writes the pickup (PREPARED) with its plan of concrete parcels — those of the selected orders
 * that are not with the carrier yet (tracking or the manual hand-over) and not held by another
 * pickup — in one transaction under the orders' locks; the plan is fixed at commit (also in the
 * database). The pickup is then claimed and sent ONCE: the claim re-checks its day and plan under
 * the same locks, so a pickup recovered after a restart is sent only if both still hold (else
 * NOT_SENT). An accepted pickup is looked up (bounded); a lost answer stays SENT — uncertain —
 * and is only looked up by its own reference. "Zrušit svoz" is a separate request at the carrier,
 * confirmed only when the carrier shows the order cancelled; until then its parcels stay blocked.
 * A pickup never changes an order or a shipment and never confirms a hand-over.
 */
@Injectable()
export class CarrierPickupsService {
  private readonly log = new Logger(CarrierPickupsService.name);
  /** The clock of the site's "today" (pickup days); replaceable in tests only. */
  clock: () => Date = () => new Date();

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
      select: { id: true, serial: true, hotelName: true, city: true, requestedShipDate: true },
    });
    const state = await this.parcelState(
      this.prisma,
      orders.map((o) => o.id),
      today,
    );
    const candidates: PickupCandidate[] = orders.flatMap((o) => {
      const s = state.get(o.id);
      if (!s) return [];
      const sameCarrier = !!gateway && sameConnection(s.shipment, gateway);
      const open = s.parcels.filter((p) => !p.pickedUp);
      const free = open.filter((p) => !p.heldBy);
      const heldBy = open.find((p) => p.heldBy)?.heldBy ?? null;
      return [
        {
          orderCode: formatCode(CODE_PREFIX.order, o.serial),
          shipmentCode: s.shipment.code,
          hotelName: o.hotelName,
          city: o.city,
          requestedShipDate: o.requestedShipDate.toISOString().slice(0, 10),
          parcelCount: s.parcels.length,
          pickedUpCount: s.parcels.length - open.length,
          eligibleParcels:
            sameCarrier && pickups
              ? free.map((p) => ({ parcelNo: p.parcelNo, carrierParcelNumber: p.number }))
              : [],
          eligible: sameCarrier && !!pickups && free.length > 0,
          blockedBy: !sameCarrier
            ? 'OTHER_CARRIER'
            : free.length === 0 && heldBy
              ? 'IN_PICKUP'
              : null,
          pickupCode: heldBy,
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
      open: open ? this.toView(open, today) : null,
      pickups: rows.map((r) => this.toView(r, today)),
    };
  }

  async view(site: SiteContext, code: string): Promise<PickupView> {
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    return this.toView(row, await this.today(site.siteId));
  }

  // --- ordering ------------------------------------------------------------------------------

  /**
   * "Objednat svoz PPL": one pickup of the active site for the selected orders' parcels that are
   * not with the carrier and not held by another pickup (all of them labelled with the site's
   * current carrier connection, environment and account), the stated day and optional window. A
   * repeated click (same request id) returns the same pickup and sends nothing again; another
   * request while a pickup of the site waits for the carrier is refused (also by the database).
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
        const ids: string[] = [];
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
          ids.push(found.id);
        }
        // The orders' locks — the same the tracking takes before recording a parcel's pickup.
        await this.lockOrders(tx, ids);
        const state = await this.parcelState(tx, ids, today);
        const plan: { parcelId: string; shipmentId: string; orderId: string; number: string }[] =
          [];
        for (const [i, id] of ids.entries()) {
          const code = orderCodes[i]!;
          const order = await tx.order.findUniqueOrThrow({
            where: { id },
            select: { status: true },
          });
          const s = state.get(id);
          if (order.status !== 'READY_FOR_PICKUP' || !s) {
            throw domainErrorWithDetails(
              409,
              'ORDER_NOT_READY_FOR_PICKUP',
              'Only a labelled order ready for pickup is planned for a pickup',
              { order: code, status: order.status },
            );
          }
          if (!sameConnection(s.shipment, gateway)) {
            throw domainErrorWithDetails(
              409,
              'PICKUP_OTHER_CARRIER',
              'The order was labelled with another carrier connection, environment or account',
              { order: code },
            );
          }
          const open = s.parcels.filter((p) => !p.pickedUp);
          const held = open.filter((p) => p.heldBy);
          if (held.length > 0) {
            throw domainErrorWithDetails(
              409,
              'ORDER_IN_PICKUP',
              'A parcel of the order is held by a pending, uncertain, coming or cancelling pickup',
              { order: code, pickups: [...new Set(held.map((p) => p.heldBy))] },
            );
          }
          if (open.length === 0) {
            throw domainErrorWithDetails(
              409,
              'ORDER_NOTHING_TO_COLLECT',
              'Every parcel of the order is already with the carrier',
              { order: code },
            );
          }
          for (const p of open) {
            plan.push({ parcelId: p.id, shipmentId: s.shipment.id, orderId: id, number: p.number });
          }
        }
        if (plan.length > pickups.maxParcels) {
          throw domainErrorWithDetails(
            422,
            'PICKUP_TOO_LARGE',
            'The carrier takes fewer parcels in one pickup order',
            { parcelCount: plan.length, maxParcels: pickups.maxParcels },
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
          parcelCount: plan.length,
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
            parcelCount: plan.length,
            payload: JSON.parse(JSON.stringify(payload)),
            createdAt: new Date(),
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
          select: { id: true, code: true },
        });
        await tx.carrierPickupParcel.createMany({
          data: plan.map((p) => ({
            pickupId: pickup.id,
            parcelId: p.parcelId,
            shipmentId: p.shipmentId,
            orderId: p.orderId,
            carrierParcelNumber: p.number,
          })),
        });
        return { id: pickup.id, code: pickup.code };
      },
    );
    // Sent after the commit; a replay drives the same pickup (it is claimed only once).
    await this.drive(result.id);
    return this.view(site, result.code);
  }

  /**
   * "Zjistit stav u dopravce": a read-only lookup of an accepted pickup, of an uncertain one (its
   * answer lost — only after the in-flight window, by its own reference), of a confirmed one still
   * without the carrier's number, and of its unresolved cancellation. Never sends anything again.
   */
  async lookup(site: SiteContext, code: string, input: LookupPickupRequest): Promise<PickupView> {
    void input;
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    const c = row.cancellations[0];
    const inFlight =
      (row.status === 'SENT' && !(await this.settled('carrier_pickups', row.id))) ||
      (c?.status === 'SENT' && !(await this.settled('carrier_pickup_cancellations', c.id)));
    if (inFlight) throw domainError(409, 'PICKUP_IN_FLIGHT', 'The carrier may still be answering');
    await this.drive(row.id, true);
    if (c && (UNRESOLVED as readonly string[]).includes(c.status)) {
      await this.driveCancel(c.id, true);
    }
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
      if (!(await this.settled('carrier_pickups', row.id))) {
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

  // --- cancelling ----------------------------------------------------------------------------

  /**
   * "Zrušit svoz": one cancellation of a pickup the carrier confirmed, recorded before the carrier
   * is called and sent once, by the pickup's own reference with its own connection and account. A
   * replay returns the same; a second request while one is live is refused, and so is one for a
   * pickup the carrier already shows cancelled. The pickup, its plan and history stay; its parcels
   * stay blocked until the carrier shows the order cancelled.
   *
   * Only up to the pickup's own day: afterwards its parcels may already be planned into another
   * pickup, so a new cancellation could not keep its promise to hold them. The day is read under
   * the site's pickup lock — the one every new pickup takes before it reads which parcels are held
   * — so a cancellation either starts before such a pickup (which then sees the parcels held) or
   * is refused. A cancellation started in time is still looked up and closed after the day.
   */
  async cancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: CancelPickupRequest,
  ): Promise<PickupView> {
    const { result } = await this.operations.run<{ id: string }>(
      'CARRIER_PICKUP_CANCEL',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`carrier_pickup:${site.siteId}`}, 0))`;
        const row = await this.find(tx, site.siteId, code);
        if (!row) throw notFound();
        await tx.$executeRaw`SELECT 1 FROM "carrier_pickups" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
        const p = await tx.carrierPickup.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true, carrierCancelledAt: true, pickupDate: true },
        });
        if (p.status !== 'CONFIRMED' || p.carrierCancelledAt !== null) {
          throw domainErrorWithDetails(
            409,
            'PICKUP_NOT_CANCELLABLE',
            'Only a pickup the carrier confirmed (and does not show cancelled) is cancelled',
            { status: p.status, cancelledByCarrier: p.carrierCancelledAt !== null },
          );
        }
        const today = await this.today(site.siteId, tx);
        if (p.pickupDate.toISOString().slice(0, 10) < today) {
          throw domainErrorWithDetails(
            409,
            'PICKUP_CANCEL_DAY_PASSED',
            'The pickup day has passed: its parcels may already be planned again',
            { today },
          );
        }
        const live = await tx.carrierPickupCancellation.findFirst({
          where: { pickupId: row.id, status: { notIn: ['REJECTED', 'NOT_CREATED'] } },
          select: { status: true },
        });
        if (live) {
          throw domainErrorWithDetails(
            409,
            'PICKUP_CANCEL_EXISTS',
            'The cancellation of this pickup was requested already',
            { status: live.status },
          );
        }
        const c = await tx.carrierPickupCancellation.create({
          data: {
            pickupId: row.id,
            reason: input.reason,
            createdAt: new Date(),
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
          select: { id: true },
        });
        return { id: c.id };
      },
    );
    await this.driveCancel(result.id);
    return this.view(site, code);
  }

  /** Moves one cancellation forward: sent once (claimed), confirmed only by the carrier's state. */
  async driveCancel(id: string, lookup = false): Promise<void> {
    const c = await this.prisma.carrierPickupCancellation.findUniqueOrThrow({
      where: { id },
      include: { pickup: true },
    });
    const pickups = await this.pickupsOf(c.pickup);
    if (!pickups) return;
    const ref = { clientReference: c.pickup.clientReference };
    if (c.status === 'PREPARED') {
      // After an attempt a person closed as not carried out, the carrier may still have cancelled
      // the pickup: its own state first — shown Canceled = confirmed, nothing is sent again.
      const closedBefore = await this.prisma.carrierPickupCancellation.count({
        where: { pickupId: c.pickupId, status: 'NOT_CREATED' },
      });
      if (closedBefore > 0) {
        const shown = await this.call((signal) => pickups.find(ref, signal)).catch(() => null);
        if (shown?.cancelled) {
          await this.markCancelled(c.pickupId, shown.state);
          return;
        }
      }
      // Claimed under the pickup's lock: never sent once the carrier shows the pickup cancelled.
      const claimed = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "carrier_pickups" WHERE "id" = ${c.pickupId}::uuid FOR UPDATE`;
        return tx.$executeRaw`
          UPDATE "carrier_pickup_cancellations" x SET "status" = 'SENT', "sent_at" = now()
           WHERE x."id" = ${id}::uuid AND x."status" = 'PREPARED'
             AND EXISTS (SELECT 1 FROM "carrier_pickups" p
                          WHERE p."id" = x."pickup_id" AND p."carrier_cancelled_at" IS NULL)`;
      });
      if (claimed !== 1) return;
      try {
        await this.call((signal) => pickups.cancel(ref, signal));
      } catch (error) {
        if (error instanceof CarrierRejectedError) {
          // A refusal may mean "already cancelled" (e.g. by an earlier attempt that was closed as
          // uncertain): the carrier's own state decides — Canceled confirms, anything else refuses.
          const shown = await this.call((signal) => pickups.find(ref, signal)).catch(() => null);
          if (shown?.cancelled) {
            await this.markCancelled(c.pickupId, shown.state);
            return;
          }
          await this.prisma.$executeRaw`
            UPDATE "carrier_pickup_cancellations"
               SET "status" = 'REJECTED', "resolved_at" = now(),
                   "error_code" = ${error.code.slice(0, 100)}, "error_message" = ${error.message.slice(0, 1000)}
             WHERE "id" = ${id}::uuid AND "status" = 'SENT'`;
        } else {
          this.log.warn(`Pickup cancellation ${id}: no usable answer from the carrier`);
          await this.prisma.$executeRaw`
            UPDATE "carrier_pickup_cancellations"
               SET "error_code" = ${PICKUP_NO_ANSWER}, "error_message" = 'The carrier did not answer usably'
             WHERE "id" = ${id}::uuid AND "status" = 'SENT'`;
        }
        return;
      }
      await this.prisma.$executeRaw`
        UPDATE "carrier_pickup_cancellations"
           SET "status" = 'ACCEPTED', "error_code" = NULL, "error_message" = NULL,
               "next_poll_at" = now() + make_interval(secs => ${LEASE_SECONDS}), "poll_count" = 0
         WHERE "id" = ${id}::uuid AND "status" = 'SENT'`;
      // One immediate look; the carrier's state confirms it.
      await this.driveCancel(id);
      return;
    }
    if (!(c.status === 'ACCEPTED' || (lookup && c.status === 'SENT'))) return;
    let found: Awaited<ReturnType<CarrierPickups['find']>>;
    try {
      found = await this.call((signal) => pickups.find(ref, signal));
    } catch {
      this.log.warn(`Pickup cancellation ${id}: lookup failed`);
      await this.scheduleCancel(id);
      return;
    }
    if (found?.cancelled) {
      await this.markCancelled(c.pickupId, found.state);
      return;
    }
    // Not (yet) shown cancelled: an accepted request is looked up again; an uncertain one stays.
    await this.prisma.$executeRaw`
      UPDATE "carrier_pickup_cancellations" SET "carrier_state" = ${found?.state?.slice(0, 100) ?? null}
       WHERE "id" = ${id}::uuid AND "status" IN ('SENT', 'ACCEPTED')`;
    await this.scheduleCancel(id);
  }

  /**
   * The carrier shows the pickup cancelled — a fact about the pickup, recorded once and kept
   * whichever attempt's lookup read it, even one a person closed meanwhile (that attempt's audit
   * stays as it is). Under the pickup's lock — the same a person's closing and a new cancellation
   * take — so a closing based on an older "Created" either committed before (and stays, the
   * pickup becomes cancelled anyway) or sees the pickup cancelled and is refused. The live attempt,
   * if any, is confirmed with it (an unsent one is never sent).
   */
  private async markCancelled(pickupId: string, carrierState: string | null): Promise<void> {
    const state = carrierState?.slice(0, 100) ?? null;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "carrier_pickups" WHERE "id" = ${pickupId}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE "carrier_pickups" SET "carrier_cancelled_at" = now(), "carrier_state" = ${state}
         WHERE "id" = ${pickupId}::uuid AND "status" = 'CONFIRMED' AND "carrier_cancelled_at" IS NULL`;
      await tx.$executeRaw`
        UPDATE "carrier_pickup_cancellations"
           SET "status" = 'CONFIRMED', "resolved_at" = now(), "next_poll_at" = NULL,
               "carrier_state" = ${state}, "error_code" = NULL, "error_message" = NULL
         WHERE "pickup_id" = ${pickupId}::uuid AND "status" IN ('PREPARED', 'SENT', 'ACCEPTED')`;
    });
  }

  /**
   * The exceptional closing of an uncertain cancellation attempt: SENT after the in-flight window
   * (its answer lost), or ACCEPTED whose bounded lookups ran out without the carrier showing it
   * cancelled — only by a person with `shipments:resolve_uncertain` who verified with the carrier
   * that it was not carried out and will not be processed (reason recorded). The carrier is asked
   * once more first: shown Canceled = confirmed, never closed. The pickup keeps its own state (it is
   * not cancelled by this); a new cancellation may be requested; this attempt is never re-sent.
   *
   * The request names the attempt (`cancellationId`, fixed when the dialog opened) — never "the
   * latest": a late closing of an older attempt never touches a newer one. The closing itself runs
   * under the pickup's lock and is refused once the carrier shows the pickup cancelled.
   */
  async resolveCancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ResolvePickupCancelRequest,
  ): Promise<PickupView> {
    const row = await this.find(this.prisma, site.siteId, code);
    if (!row) throw notFound();
    // Only an attempt of this pickup of this site.
    const c = await this.prisma.carrierPickupCancellation.findFirst({
      where: { id: input.cancellationId, pickupId: row.id },
    });
    if (!c) throw new NotFoundException('Cancellation attempt not found');
    const fingerprint = {
      actorId,
      siteId: site.siteId,
      code,
      cancellationId: c.id,
      reason: input.reason,
    };
    const replay = await this.operations.peek(
      'CARRIER_PICKUP_CANCEL_RESOLVE',
      input.requestId,
      fingerprint,
    );
    if (!replay) {
      if (c.status !== 'SENT' && c.status !== 'ACCEPTED') {
        throw domainErrorWithDetails(
          409,
          'PICKUP_CANCEL_NOT_UNCERTAIN',
          'Only an uncertain cancellation attempt is closed by a person',
          { status: c.status },
        );
      }
      if (c.status === 'SENT' && !(await this.settled('carrier_pickup_cancellations', c.id))) {
        throw domainError(409, 'PICKUP_IN_FLIGHT', 'The carrier may still be answering');
      }
      if (c.status === 'ACCEPTED' && c.nextPollAt !== null) {
        throw domainError(
          409,
          'PICKUP_CANCEL_STILL_LOOKED_UP',
          'The carrier is still being asked about this cancellation',
        );
      }
      // The carrier's own state first: Canceled confirms it; an error or "Created" closes nothing.
      await this.driveCancel(c.id, true);
    }
    await this.operations.run(
      'CARRIER_PICKUP_CANCEL_RESOLVE',
      input.requestId,
      fingerprint,
      async (tx) => {
        // The common authority with the carrier's "Canceled" (markCancelled) and a new attempt.
        await tx.$executeRaw`SELECT 1 FROM "carrier_pickups" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
        const closed = await tx.$executeRaw`
          UPDATE "carrier_pickup_cancellations" x
             SET "status" = 'NOT_CREATED', "resolved_at" = now(), "next_poll_at" = NULL,
                 "resolved_by" = ${actorId}::uuid, "resolution_reason" = ${input.reason}
           WHERE x."id" = ${c.id}::uuid
             AND (x."status" = 'SENT' OR (x."status" = 'ACCEPTED' AND x."next_poll_at" IS NULL))
             AND EXISTS (SELECT 1 FROM "carrier_pickups" p
                          WHERE p."id" = x."pickup_id" AND p."carrier_cancelled_at" IS NULL)`;
        if (closed !== 1) {
          const now = await tx.carrierPickupCancellation.findUniqueOrThrow({
            where: { id: c.id },
            select: { status: true },
          });
          throw domainErrorWithDetails(
            409,
            'PICKUP_CANCEL_NOT_UNCERTAIN',
            'Only an uncertain cancellation attempt is closed by a person',
            { status: now.status },
          );
        }
        return { code };
      },
    );
    return this.view(site, code);
  }

  private async scheduleCancel(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "carrier_pickup_cancellations"
         SET "poll_count" = "poll_count" + 1,
             "next_poll_at" = CASE WHEN "poll_count" + 1 >= ${PICKUP_MAX_POLLS} THEN NULL
                                   ELSE now() + make_interval(secs => LEAST(5 * power(2, "poll_count" + 1), 300)) END
       WHERE "id" = ${id}::uuid AND "status" = 'ACCEPTED'`;
  }

  // --- talking to the carrier ----------------------------------------------------------------

  private async pickupsOf(p: {
    carrierCode: string;
    carrierConnection: string;
    carrierEnvironment: string;
    carrierAccount: string;
  }): Promise<CarrierPickups | null> {
    const gateway = await this.carriers.forConnection({
      carrierCode: p.carrierCode,
      connection: p.carrierConnection,
      environment: p.carrierEnvironment,
      account: p.carrierAccount,
    });
    // Only its own connection, environment and account — never a fallback.
    return gateway?.pickups ?? null;
  }

  /**
   * Claims a written pickup for sending — exactly one caller wins (row lock + status check). Under
   * the orders' locks, its day must not have passed and its plan must still hold (every order ready
   * for pickup, every shipment labelled, no planned parcel with the carrier); otherwise it is closed
   * as NOT_SENT and never sent.
   */
  private async claim(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "carrier_pickups" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (row?.status !== 'PREPARED') return false;
      const p = await tx.carrierPickup.findUniqueOrThrow({
        where: { id },
        select: {
          siteId: true,
          pickupDate: true,
          parcels: { select: { orderId: true, parcelId: true, shipmentId: true } },
        },
      });
      const today = await this.today(p.siteId, tx);
      const orderIds = [...new Set(p.parcels.map((x) => x.orderId))];
      await this.lockOrders(tx, orderIds);
      let problem: { code: string; message: string } | null = null;
      if (p.pickupDate.toISOString().slice(0, 10) < today) {
        problem = {
          code: 'PICKUP_DAY_PASSED',
          message: 'The pickup day passed before it was sent',
        };
      } else {
        const orders = await tx.order.count({
          where: { id: { in: orderIds }, status: 'READY_FOR_PICKUP' },
        });
        const shipments = await tx.shipment.count({
          where: {
            id: { in: [...new Set(p.parcels.map((x) => x.shipmentId))] },
            status: 'LABELED',
          },
        });
        const picked = await tx.shipmentParcelProgress.count({
          // With the carrier = a pickup source (CARRIER, MANUAL, or CARRIER_IMPLIED by a delivery
          // without a pickup scan — whose time stays unknown, so never by pickedUpAt).
          where: {
            parcelId: { in: p.parcels.map((x) => x.parcelId) },
            pickedUpSource: { not: null },
          },
        });
        if (
          orders !== orderIds.length ||
          shipments !== new Set(p.parcels.map((x) => x.shipmentId)).size ||
          picked > 0
        ) {
          problem = {
            code: 'PICKUP_PLAN_CHANGED',
            message:
              'Its plan no longer held before it was sent (an order, shipment or parcel changed)',
          };
        }
      }
      if (problem) {
        await tx.$executeRaw`
          UPDATE "carrier_pickups"
             SET "status" = 'NOT_SENT', "resolved_at" = now(),
                 "error_code" = ${problem.code}, "error_message" = ${problem.message}
           WHERE "id" = ${id}::uuid AND "status" = 'PREPARED'`;
        return false;
      }
      await tx.$executeRaw`
        UPDATE "carrier_pickups" SET "status" = 'SENT', "sent_at" = now()
         WHERE "id" = ${id}::uuid AND "status" = 'PREPARED'`;
      return true;
    });
  }

  /** Moves one pickup forward (see {@link order}, {@link lookup}). */
  async drive(id: string, lookup = false): Promise<void> {
    const p = await this.prisma.carrierPickup.findUniqueOrThrow({ where: { id } });
    const pickups = await this.pickupsOf(p);
    if (!pickups) return;
    if (p.status === 'PREPARED') {
      if (!(await this.claim(id))) return; // someone else sends it, or it no longer holds
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
          // (A state read for a pickup the carrier already shows cancelled never replaces it.)
          await this.prisma.$executeRaw`
            UPDATE "carrier_pickups"
               SET "carrier_order_number" = ${number},
                   "carrier_state" = CASE WHEN "carrier_cancelled_at" IS NULL THEN ${state} ELSE "carrier_state" END
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

  /**
   * Background work (several API processes share it): written pickups and cancellations not sent
   * yet — e.g. after a restart between the commit and the call — are claimed and sent (or closed as
   * NOT_SENT); accepted ones are looked up (bounded, SKIP LOCKED).
   */
  async pollDue(limit = 5): Promise<number> {
    const grace = this.env.CARRIER_SETTLE_SECONDS;
    const written = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "carrier_pickups"
       WHERE "status" = 'PREPARED' AND "created_at" <= now() - make_interval(secs => ${grace})
       ORDER BY "created_at" LIMIT ${limit}`;
    for (const r of written) {
      try {
        await this.drive(r.id);
      } catch (error) {
        this.log.warn(`Pickup ${r.id} not sent: ${String(error)}`);
      }
    }
    const cancels = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "carrier_pickup_cancellations"
       WHERE "status" = 'PREPARED' AND "created_at" <= now() - make_interval(secs => ${grace})
       ORDER BY "created_at" LIMIT ${limit}`;
    for (const r of cancels) {
      try {
        await this.driveCancel(r.id);
      } catch (error) {
        this.log.warn(`Pickup cancellation ${r.id} not sent: ${String(error)}`);
      }
    }
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
    const dueCancels = await this.prisma.$queryRaw<{ id: string; lease: Date }[]>`
      UPDATE "carrier_pickup_cancellations" c
         SET "next_poll_at" = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE c."id" IN (SELECT q."id" FROM "carrier_pickup_cancellations" q
                         WHERE q."status" = 'ACCEPTED' AND q."next_poll_at" <= now()
                         ORDER BY q."next_poll_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING c."id", c."next_poll_at" AS "lease"`;
    for (const r of dueCancels) {
      try {
        await this.driveCancel(r.id);
      } catch (error) {
        this.log.warn(`Pickup cancellation lookup ${r.id} failed: ${String(error)}`);
      }
      const untouched = await this.prisma.carrierPickupCancellation.count({
        where: { id: r.id, nextPollAt: r.lease, status: 'ACCEPTED' },
      });
      if (untouched) await this.scheduleCancel(r.id);
    }
    return written.length + cancels.length + due.length + dueCancels.length;
  }

  // --- helpers -------------------------------------------------------------------------------

  private async lockOrders(tx: Tx, ids: string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
    }
  }

  /**
   * Per order: its labelled shipment and each parcel — number, with the carrier or not (the
   * tracking's progress, or the manual hand-over), and the pickup still holding it (see
   * {@link holding}).
   */
  private async parcelState(db: Tx, orderIds: string[], today: string) {
    const out = new Map<
      string,
      {
        shipment: {
          id: string;
          code: string;
          carrierCode: string | null;
          carrierConnection: string | null;
          carrierEnvironment: string | null;
          carrierAccount: string | null;
        };
        parcels: {
          id: string;
          parcelNo: number;
          number: string;
          pickedUp: boolean;
          heldBy: string | null;
        }[];
      }
    >();
    if (orderIds.length === 0) return out;
    const shipments = await db.shipment.findMany({
      where: { orderId: { in: orderIds }, status: 'LABELED' },
      select: {
        id: true,
        orderId: true,
        code: true,
        carrierCode: true,
        carrierConnection: true,
        carrierEnvironment: true,
        carrierAccount: true,
        parcels: {
          orderBy: { parcelNo: 'asc' },
          select: {
            id: true,
            parcelNo: true,
            carrierParcelNumber: true,
            progress: { select: { pickedUpSource: true } },
          },
        },
      },
    });
    const held = await db.carrierPickupParcel.findMany({
      where: {
        parcelId: { in: shipments.flatMap((s) => s.parcels.map((p) => p.id)) },
        pickup: holding(today),
      },
      select: { parcelId: true, pickup: { select: { code: true } } },
    });
    const heldBy = new Map(held.map((h) => [h.parcelId, h.pickup.code]));
    for (const s of shipments) {
      out.set(s.orderId, {
        shipment: s,
        parcels: s.parcels.map((p) => ({
          id: p.id,
          parcelNo: p.parcelNo,
          number: p.carrierParcelNumber ?? '',
          pickedUp: !!p.progress?.pickedUpSource,
          heldBy: heldBy.get(p.id) ?? null,
        })),
      });
    }
    return out;
  }

  private async settled(
    table: 'carrier_pickups' | 'carrier_pickup_cancellations',
    id: string,
  ): Promise<boolean> {
    const secs = this.env.CARRIER_SETTLE_SECONDS;
    const [row] =
      table === 'carrier_pickups'
        ? await this.prisma.$queryRaw<{ settled: boolean }[]>`
            SELECT ("sent_at" + make_interval(secs => ${secs})) <= now() AS settled
              FROM "carrier_pickups" WHERE "id" = ${id}::uuid`
        : await this.prisma.$queryRaw<{ settled: boolean }[]>`
            SELECT ("sent_at" + make_interval(secs => ${secs})) <= now() AS settled
              FROM "carrier_pickup_cancellations" WHERE "id" = ${id}::uuid`;
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
    return localDate(this.clock(), timeZone);
  }

  private lookupFrom(sentAt: Date | null): string | null {
    return sentAt
      ? new Date(sentAt.getTime() + this.env.CARRIER_SETTLE_SECONDS * 1000).toISOString()
      : null;
  }

  private toView(r: PickupRow, today: string): PickupView {
    const c = r.cancellations[0] ?? null;
    const date = r.pickupDate.toISOString().slice(0, 10);
    return {
      code: r.code,
      status: r.status,
      date,
      window: r.windowFrom && r.windowTo ? { from: r.windowFrom, to: r.windowTo } : null,
      parcelCount: r.parcelCount,
      carrier: {
        code: r.carrierCode,
        environment: r.carrierEnvironment === 'PRODUCTION' ? 'PRODUCTION' : 'TEST',
      },
      carrierOrderNumber: r.carrierOrderNumber,
      carrierState: r.carrierState,
      cancelledByCarrierAt: r.carrierCancelledAt?.toISOString() ?? null,
      dayPassed: date < today,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionReason: r.resolutionReason,
      lookupFrom: r.status === 'SENT' ? this.lookupFrom(r.sentAt) : null,
      cancellation: c
        ? {
            id: c.id,
            status: c.status,
            reason: c.reason,
            createdAt: c.createdAt.toISOString(),
            sentAt: c.sentAt?.toISOString() ?? null,
            resolvedAt: c.resolvedAt?.toISOString() ?? null,
            carrierState: c.carrierState,
            errorCode: c.errorCode,
            errorMessage: c.errorMessage,
            lookupFrom: c.status === 'SENT' ? this.lookupFrom(c.sentAt) : null,
            lookingUp: c.status === 'ACCEPTED' && c.nextPollAt !== null,
            resolutionReason: c.resolutionReason,
          }
        : null,
      parcels: r.parcels
        .map((p) => ({
          orderCode: formatCode(CODE_PREFIX.order, p.order.serial),
          shipmentCode: p.shipment.code,
          hotelName: p.order.hotelName,
          parcelNo: p.parcel.parcelNo,
          carrierParcelNumber: p.carrierParcelNumber,
          // Today's state of the parcel — not evidence of what this pickup collected.
          withCarrierNow: !!p.parcel.progress?.pickedUpSource,
          orderStatus: p.order.status,
        }))
        .sort((a, b) => a.orderCode.localeCompare(b.orderCode) || a.parcelNo - b.parcelNo),
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
