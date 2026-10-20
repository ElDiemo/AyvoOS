import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ParcelTracking, Shipment, TrackingEvent } from '@ayvo/types';
import type { CarrierTracking, TrackingMeaning } from '../carriers/carrier.js';
import { WARNING_MEANINGS } from '../carriers/ppl/ppl-tracking.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ShipmentCarrierFlow } from './shipment-carrier-flow.service.js';

type Tx = Prisma.TransactionClient;

/** Consecutive failed looks after which automatic tracking pauses ("Obnovit tracking" resumes). */
export const TRACKING_MAX_FAILURES = 12;
/** The longest wait between two looks after failures. */
const MAX_BACKOFF_SECONDS = 6 * 3600;
/** A look holds its shipment this long (a crashed process releases it by expiry). */
const LEASE_SECONDS = 120;
/** Shipments looked at per round. */
const BATCH = 10;

/** What one look did (for tests and the manual refresh). */
export type TrackingOutcome = 'BUSY' | 'NOT_TRACKED' | 'FAILED' | 'SYNCED';

const ACTIVE_ORDER = ['READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER'] as const;

/**
 * Automatic tracking of labelled shipments at their carrier (doc 031, ADR 0029). Each shipment has
 * a schedule in the database (`shipment_tracking`): the next look, failures with back-off and a
 * lease, so a restart or several processes simply continue. A look asks the carrier — with the
 * shipment's OWN connection, environment and account — for every parcel number, stores each
 * event once (its own code, time and fetch time), and moves forward only what the carrier proves:
 * a parcel picked up (its crate cycle DISPATCHED), delivered (DELIVERED), the whole order handed
 * over / delivered when every parcel is. Nothing is ever moved back; an outage keeps the last known
 * state.
 */
@Injectable()
export class ShipmentTrackingService {
  private readonly log = new Logger(ShipmentTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flow: ShipmentCarrierFlow,
    private readonly cycles: CrateCyclesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get interval(): number {
    return this.env.CARRIER_TRACKING_SECONDS;
  }

  /** One round of the poller: schedules newly labelled shipments, then looks at those due. */
  async due(): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "shipment_tracking" ("shipment_id", "next_at")
      SELECT s."id", now() FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       WHERE s."status" = 'LABELED' AND s."carrier_code" IS NOT NULL
         AND o."status"::text = ANY(${[...ACTIVE_ORDER]}::text[])
      ON CONFLICT ("shipment_id") DO NOTHING`;
    const due = await this.prisma.$queryRaw<{ shipment_id: string }[]>`
      SELECT "shipment_id" FROM "shipment_tracking"
       WHERE "stopped_at" IS NULL AND "next_at" <= now()
         AND ("lease_until" IS NULL OR "lease_until" < now())
       ORDER BY "next_at" LIMIT ${BATCH}`;
    for (const { shipment_id } of due) {
      try {
        await this.sync(shipment_id, false);
      } catch (error) {
        this.log.warn(`Tracking of ${shipment_id} failed: ${String(error)}`);
      }
    }
  }

  /**
   * One look at the carrier for one shipment. `manual` ("Obnovit tracking") ignores the schedule
   * and resumes a paused one, but never runs beside another look (the lease).
   */
  async sync(shipmentId: string, manual: boolean): Promise<TrackingOutcome> {
    if (manual) {
      await this.prisma.$executeRaw`
        INSERT INTO "shipment_tracking" ("shipment_id", "next_at") VALUES (${shipmentId}::uuid, now())
        ON CONFLICT ("shipment_id") DO NOTHING`;
    }
    const row = await this.prisma.shipmentTracking.findUnique({ where: { shipmentId } });
    // Done (every parcel delivered) or cancelled: nothing more to ask.
    if (row?.stopReason === 'DELIVERED' || row?.stopReason === 'CANCELLED') return 'NOT_TRACKED';
    const claimed = await this.prisma.$queryRaw<{ shipment_id: string }[]>`
      UPDATE "shipment_tracking"
         SET "lease_until" = now() + make_interval(secs => ${LEASE_SECONDS}),
             "last_attempt_at" = now(), "updated_at" = now(),
             "stopped_at" = CASE WHEN ${manual} AND "stop_reason" = 'GAVE_UP' THEN NULL ELSE "stopped_at" END,
             "stop_reason" = CASE WHEN ${manual} AND "stop_reason" = 'GAVE_UP' THEN NULL ELSE "stop_reason" END,
             "next_at" = CASE WHEN ${manual} AND "stop_reason" = 'GAVE_UP' THEN now() ELSE "next_at" END,
             "failures" = CASE WHEN ${manual} AND "stop_reason" = 'GAVE_UP' THEN 0 ELSE "failures" END
       WHERE "shipment_id" = ${shipmentId}::uuid
         AND ("lease_until" IS NULL OR "lease_until" < now())
         AND (${manual} OR ("stopped_at" IS NULL AND "next_at" <= now()))
         AND ("stop_reason" IS NULL OR "stop_reason" = 'GAVE_UP')
      RETURNING "shipment_id"`;
    if (claimed.length === 0) return 'BUSY';

    const shipment = await this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: {
        order: { select: { status: true } },
        parcels: { select: { id: true, carrierParcelNumber: true }, orderBy: { parcelNo: 'asc' } },
      },
    });
    if (shipment.status === 'CANCELLED' || shipment.order.status === 'CANCELLED') {
      await this.stop(shipmentId, 'CANCELLED');
      return 'NOT_TRACKED';
    }
    // A cancellation in progress decides by itself; tracking waits (a full history comes later).
    if (shipment.status !== 'LABELED') {
      await this.release(shipmentId, this.interval);
      return 'NOT_TRACKED';
    }
    const numbers = shipment.parcels.map((p) => p.carrierParcelNumber!);
    const gateway = await this.flow.gatewayOf(shipment);
    if (!gateway) {
      await this.fail(shipmentId, 'Připojení dopravce této přepravy už není k dispozici');
      return 'FAILED';
    }
    let answer: CarrierTracking;
    try {
      answer = await this.call((signal) => gateway.track({ parcels: numbers }, signal));
    } catch (error) {
      this.log.warn(`Tracking ${shipment.code}: ${String(error)}`);
      await this.fail(shipmentId, 'Dopravce teď neodpovídá – platí poslední známý stav');
      return 'FAILED';
    }
    const fetchedAt = new Date();
    let applied: boolean | null;
    try {
      applied = await this.prisma.$transaction(
        async (tx) =>
          this.apply(tx, shipmentId, answer, fetchedAt, {
            carrierCode: gateway.code,
            environment: gateway.environment,
          }),
        // As the other mutating operations: a large order or a wait for its lock may take time.
        { maxWait: 20_000, timeout: 30_000 },
      );
    } catch (error) {
      // Nothing of this look was stored (one transaction): counted as a failed look.
      this.log.warn(`Tracking ${shipment.code} not applied: ${String(error)}`);
      await this.fail(
        shipmentId,
        'Odpověď dopravce se nepodařilo zpracovat – platí poslední známý stav',
      );
      return 'FAILED';
    }
    // Cancelled meanwhile (under the order lock): nothing applied; look again later.
    if (applied === null) {
      await this.release(shipmentId, this.interval);
      return 'NOT_TRACKED';
    }
    return 'SYNCED';
  }

  /**
   * Stores the answer and moves the parcels, their crate cycles and the order forward — in one
   * transaction, under the order's lock (two looks never apply the same proof twice). Returns
   * whether every parcel is delivered, or null when the shipment is no longer labelled.
   */
  private async apply(
    tx: Tx,
    shipmentId: string,
    answer: CarrierTracking,
    fetchedAt: Date,
    carrier: { carrierCode: string; environment: string },
  ): Promise<boolean | null> {
    const s = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { id: true, code: true, orderId: true, siteId: true },
    });
    await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${s.orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: s.orderId } });
    const live = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        status: true,
        parcels: {
          select: {
            id: true,
            parcelNo: true,
            carrierParcelNumber: true,
            cycleId: true,
            crateId: true,
          },
          orderBy: { parcelNo: 'asc' },
        },
      },
    });
    if (live.status !== 'LABELED') return null;
    const byNumber = new Map(answer.parcels.map((p) => [p.number, p]));
    // Each event by its own parcel number — never by position in the answer.
    const rows = live.parcels.flatMap((p) =>
      (byNumber.get(p.carrierParcelNumber!)?.events ?? []).map((e) => ({
        shipmentId,
        parcelId: p.id,
        carrierCode: carrier.carrierCode,
        carrierEnvironment: carrier.environment,
        carrierParcelNumber: p.carrierParcelNumber!,
        statusId: e.statusId,
        code: e.code,
        phase: e.phase,
        group: e.group,
        name: e.name,
        meaning: e.meaning,
        occurredAt: e.occurredAt,
        fetchedAt,
      })),
    );
    // A repeated or late answer adds nothing (unique: parcel × status × code × time).
    if (rows.length > 0)
      await tx.shipmentTrackingEvent.createMany({ data: rows, skipDuplicates: true });
    const missing = live.parcels
      .filter((p) => !byNumber.get(p.carrierParcelNumber!)?.found)
      .map((p) => p.carrierParcelNumber!);

    let operationId: string | null = null;
    const operation = async () => {
      operationId ??= await this.operation(tx, shipmentId, fetchedAt);
      return operationId;
    };
    const progressRows = await tx.shipmentParcelProgress.findMany({ where: { shipmentId } });
    const progress = new Map(progressRows.map((r) => [r.parcelId, r]));
    for (const p of live.parcels) {
      const events = await tx.shipmentTrackingEvent.findMany({
        where: { parcelId: p.id, meaning: { in: ['PICKED_UP', 'DELIVERED'] } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { id: true, meaning: true, occurredAt: true },
      });
      const pickup = events.find((e) => e.meaning === 'PICKED_UP') ?? null;
      const delivery = events.find((e) => e.meaning === 'DELIVERED') ?? null;
      const was = progress.get(p.id) ?? null;
      const wasPicked = !!was?.pickedUpSource;
      const wasDelivered = !!was?.deliveredAt;
      let source = was?.pickedUpSource ?? null;
      let pickedAt = was?.pickedUpAt ?? null;
      let pickedEvent = was?.pickedUpEventId ?? null;
      if ((!source || source === 'CARRIER_IMPLIED') && pickup) {
        source = 'CARRIER';
        pickedAt = pickup.occurredAt;
        pickedEvent = pickup.id;
      } else if (!source && delivery) {
        // Delivered without a pickup event: picked up, its time unknown — never invented.
        source = 'CARRIER_IMPLIED';
      }
      const deliveredNow = !wasDelivered && !!delivery;
      if (
        source === (was?.pickedUpSource ?? null) &&
        pickedEvent === (was?.pickedUpEventId ?? null) &&
        !deliveredNow
      ) {
        continue;
      }
      const data = {
        pickedUpSource: source,
        pickedUpAt: pickedAt,
        pickedUpEventId: pickedEvent,
        ...(deliveredNow
          ? { deliveredAt: delivery.occurredAt, deliveredEventId: delivery.id }
          : {}),
      };
      if (was) await tx.shipmentParcelProgress.update({ where: { parcelId: p.id }, data });
      else
        await tx.shipmentParcelProgress.create({ data: { parcelId: p.id, shipmentId, ...data } });

      const cycle = { id: p.cycleId, crateId: p.crateId, siteId: s.siteId };
      const facts = { order: order.code, shipment: s.code, parcelNumber: p.carrierParcelNumber! };
      if (!wasPicked && source === 'CARRIER') {
        await this.cycles.dispatch(tx, cycle, {
          actorId: null,
          operationId: await operation(),
          occurredAt: pickedAt!,
          ...facts,
        });
        await this.orderEvent(tx, order.id, 'PARCEL_PICKED_UP', pickedAt!, await operation(), {
          shipment: s.code,
          parcelNo: p.parcelNo,
          number: p.carrierParcelNumber,
        });
      }
      if (deliveredNow) {
        await this.cycles.deliver(tx, cycle, {
          operationId: await operation(),
          occurredAt: delivery.occurredAt,
          ...facts,
          pickupTimeUnknown: source === 'CARRIER_IMPLIED',
        });
        await this.orderEvent(
          tx,
          order.id,
          'PARCEL_DELIVERED',
          delivery.occurredAt,
          await operation(),
          {
            shipment: s.code,
            parcelNo: p.parcelNo,
            number: p.carrierParcelNumber,
            pickupTimeUnknown: source === 'CARRIER_IMPLIED' ? true : undefined,
          },
        );
      }
    }

    // The order follows every parcel (doc 031 §3).
    const now = await tx.shipmentParcelProgress.findMany({ where: { shipmentId } });
    const count = live.parcels.length;
    const picked = now.filter((r) => r.pickedUpSource).length;
    const deliveredAll = now.filter((r) => r.deliveredAt).length === count;
    const latest = (dates: (Date | null)[]) =>
      dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);
    if (deliveredAll && order.status !== 'DELIVERED') {
      await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
      await this.orderEvent(
        tx,
        order.id,
        'DELIVERED',
        latest(now.map((r) => r.deliveredAt))!,
        await operation(),
        { shipment: s.code, parcels: count },
      );
    } else if (
      !deliveredAll &&
      picked === count &&
      (order.status === 'READY_TO_DISPATCH' || order.status === 'READY_FOR_PICKUP')
    ) {
      await tx.order.update({ where: { id: order.id }, data: { status: 'HANDED_TO_CARRIER' } });
      await this.orderEvent(
        tx,
        order.id,
        'HANDED_TO_CARRIER',
        latest(now.map((r) => r.pickedUpAt)) ?? fetchedAt,
        await operation(),
        { shipment: s.code, parcels: count, readyConfirmed: order.status === 'READY_FOR_PICKUP' },
      );
    }

    await tx.shipmentTracking.update({
      where: { shipmentId },
      data: {
        failures: 0,
        lastSuccessAt: fetchedAt,
        lastError: null,
        missingNumbers: missing,
        leaseUntil: null,
        // Every parcel delivered: tracking is done.
        nextAt: deliveredAll ? null : new Date(fetchedAt.getTime() + this.interval * 1000),
        stoppedAt: deliveredAll ? fetchedAt : null,
        stopReason: deliveredAll ? 'DELIVERED' : null,
      },
    });
    return deliveredAll;
  }

  /** The operation all automatic events of one look belong to (no user: ADR 0029). */
  private async operation(tx: Tx, shipmentId: string, at: Date): Promise<string> {
    const requestId = randomUUID();
    await tx.operationRequest.create({
      data: {
        requestId,
        kind: 'SHIPMENT_TRACKING_SYNC',
        payloadSha256: createHash('sha256')
          .update(JSON.stringify({ shipmentId, at: at.toISOString() }))
          .digest('hex'),
      },
    });
    return requestId;
  }

  private async orderEvent(
    tx: Tx,
    orderId: string,
    type: 'PARCEL_PICKED_UP' | 'PARCEL_DELIVERED' | 'HANDED_TO_CARRIER' | 'DELIVERED',
    occurredAt: Date,
    operationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.orderEvent.create({
      data: {
        orderId,
        type,
        occurredAt,
        actorId: null,
        source: 'CARRIER',
        operationRequestId: operationId,
        payload: JSON.parse(JSON.stringify(payload)),
      },
    });
  }

  private async fail(shipmentId: string, message: string): Promise<void> {
    const row = await this.prisma.shipmentTracking.findUniqueOrThrow({ where: { shipmentId } });
    const failures = row.failures + 1;
    const wait = Math.min(this.interval * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
    const gaveUp = failures >= TRACKING_MAX_FAILURES;
    await this.prisma.shipmentTracking.update({
      where: { shipmentId },
      data: {
        failures,
        lastError: message,
        leaseUntil: null,
        nextAt: gaveUp ? null : new Date(Date.now() + wait * 1000),
        stoppedAt: gaveUp ? new Date() : null,
        stopReason: gaveUp ? 'GAVE_UP' : null,
      },
    });
  }

  private async release(shipmentId: string, seconds: number): Promise<void> {
    await this.prisma.shipmentTracking.update({
      where: { shipmentId },
      data: { leaseUntil: null, nextAt: new Date(Date.now() + seconds * 1000) },
    });
  }

  private async stop(shipmentId: string, reason: 'CANCELLED') {
    await this.prisma.shipmentTracking.update({
      where: { shipmentId },
      data: { leaseUntil: null, nextAt: null, stoppedAt: new Date(), stopReason: reason },
    });
  }

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

  // --- reading ------------------------------------------------------------------------------

  /** The tracking of a shipment and of each of its parcels (by parcel id), for the order. */
  async view(
    shipmentId: string,
    parcelIds: string[],
  ): Promise<{ summary: Shipment['tracking']; parcels: Map<string, ParcelTracking> }> {
    const [schedule, progress, events] = await Promise.all([
      this.prisma.shipmentTracking.findUnique({ where: { shipmentId } }),
      this.prisma.shipmentParcelProgress.findMany({ where: { shipmentId } }),
      this.prisma.shipmentTrackingEvent.findMany({
        where: { shipmentId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const progressOf = new Map(progress.map((p) => [p.parcelId, p]));
    const parcels = new Map<string, ParcelTracking>();
    const missing = new Set(schedule?.missingNumbers ?? []);
    const missingParcels = new Set(
      (
        await this.prisma.shipmentParcel.findMany({
          where: { shipmentId, carrierParcelNumber: { in: [...missing] } },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    for (const id of parcelIds) {
      const own: TrackingEvent[] = events
        .filter((e) => e.parcelId === id)
        .map((e) => ({
          statusId: e.statusId,
          code: e.code,
          phase: e.phase,
          name: e.name,
          meaning: e.meaning as TrackingMeaning,
          occurredAt: e.occurredAt.toISOString(),
          fetchedAt: e.fetchedAt.toISOString(),
        }));
      const p = progressOf.get(id);
      const last = own.at(-1) ?? null;
      // A problem the carrier reported after the last proven step (shown, never a state).
      const step = p?.deliveredAt ?? p?.pickedUpAt ?? null;
      const warning =
        [...own]
          .reverse()
          .find(
            (e) =>
              (WARNING_MEANINGS.includes(e.meaning) ||
                (e.meaning === 'PICKUP_POINT' && !p?.deliveredAt)) &&
              (!step || new Date(e.occurredAt) >= step),
          ) ?? null;
      parcels.set(id, {
        pickedUp: p?.pickedUpSource
          ? {
              source: p.pickedUpSource as 'CARRIER' | 'MANUAL' | 'CARRIER_IMPLIED',
              at: p.pickedUpAt?.toISOString() ?? null,
            }
          : null,
        deliveredAt: p?.deliveredAt?.toISOString() ?? null,
        last,
        warning,
        missing: missingParcels.has(id),
        events: own,
      });
    }
    const summary: Shipment['tracking'] = schedule
      ? {
          pickedUp: progress.filter((p) => p.pickedUpSource).length,
          delivered: progress.filter((p) => p.deliveredAt).length,
          parcels: parcelIds.length,
          lastSuccessAt: schedule.lastSuccessAt?.toISOString() ?? null,
          lastAttemptAt: schedule.lastAttemptAt?.toISOString() ?? null,
          lastError: schedule.lastError,
          failures: schedule.failures,
          nextAt: schedule.nextAt?.toISOString() ?? null,
          stopped: (schedule.stopReason as 'DELIVERED' | 'CANCELLED' | 'GAVE_UP' | null) ?? null,
        }
      : // Labelled but not scheduled yet (the next poller round does it): nothing checked so far.
        {
          pickedUp: progress.filter((p) => p.pickedUpSource).length,
          delivered: progress.filter((p) => p.deliveredAt).length,
          parcels: parcelIds.length,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          failures: 0,
          nextAt: null,
          stopped: null,
        };
    return { summary, parcels };
  }
}
