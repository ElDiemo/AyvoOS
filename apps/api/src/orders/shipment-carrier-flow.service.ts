import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import {
  CARRIERS,
  CarrierRejectedError,
  type CarrierGateway,
  type CarrierLabelFile,
  type CarrierParcelNumber,
  type CarrierPollOutcome,
  type CarrierRegistry,
  type CarrierShipmentRequest,
} from './carriers/carrier.js';
import { ShipmentDeriver } from './shipment-deriver.service.js';
import { shipmentEvent, type Step } from './shipment-events.js';

type Tx = Prisma.TransactionClient;
type By = { actorId: string; operationId: string };

/** The error code of a finished call whose outcome is unknown (never re-sent). */
export const NO_ANSWER = 'NO_ANSWER';
export const UNRESOLVED = ['PREPARED', 'SENT', 'ACCEPTED', 'CREATED'] as const;
/** Bounded automatic polling of an accepted request: attempts and back-off (seconds). */
export const MAX_POLLS = 30;
const backoff = (n: number) => Math.min(5 * 2 ** n, 300);
/** Upper bound of one stored label file. */
const MAX_LABEL_BYTES = 5 * 1024 * 1024;

const step = (by: By): Step => ({ ...by, occurredAt: new Date() });

/** Whether bytes really are the claimed label format (never trust a content type alone). */
export function isLabelFile(file: CarrierLabelFile): boolean {
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_LABEL_BYTES) return false;
  const head = Buffer.from(file.bytes.subarray(0, 8)).toString('latin1');
  if (file.format === 'PDF') return head.startsWith('%PDF-');
  return /^\s*\^XA/.test(Buffer.from(file.bytes.subarray(0, 64)).toString('latin1'));
}

/**
 * Everything that talks to the carrier for a shipment (doc 029 §3): sending a written request
 * exactly once (claim), recording each answer in its own transaction, bounded polling of accepted
 * requests (also after a restart — the state is in the database), downloading and checking labels
 * before storing them, and the asynchronous cancellation. Calls are always made with the
 * connection recorded on the request and abort after CARRIER_CALL_TIMEOUT_SECONDS.
 */
@Injectable()
export class ShipmentCarrierFlow {
  private readonly log = new Logger(ShipmentCarrierFlow.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deriver: ShipmentDeriver,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
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

  gatewayOf(ref: {
    carrierCode: string | null;
    carrierConnection: string | null;
    carrierEnvironment: string | null;
  }): CarrierGateway | null {
    if (!ref.carrierCode || !ref.carrierConnection || !ref.carrierEnvironment) return null;
    return this.carriers.forConnection({
      carrierCode: ref.carrierCode,
      connection: ref.carrierConnection,
      environment: ref.carrierEnvironment,
    });
  }

  // --- creating ------------------------------------------------------------------------------

  /**
   * Moves one request forward. PREPARED is claimed (SENT) by exactly one caller before the carrier
   * is called. SENT is looked up only when `lookup` (an explicit, permitted "Ověřit" after the
   * in-flight window); ACCEPTED is polled; CREATED gets its labels.
   */
  async drive(attemptId: string, by: By, lookup = false): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const carrier = this.gatewayOf(attempt);
    if (!carrier) return;
    const request = attempt.payload as unknown as CarrierShipmentRequest;
    if (attempt.status === 'PREPARED') {
      const claimed = await this.prisma.$executeRaw`
        UPDATE "shipment_carrier_requests" SET "status" = 'SENT', "sent_at" = now()
         WHERE "id" = ${attemptId}::uuid AND "status" = 'PREPARED'`;
      if (claimed !== 1) return; // someone else is sending it
      let outcome: CarrierPollOutcome;
      try {
        outcome = await this.call((signal) => carrier.create(request, signal));
      } catch (error) {
        if (error instanceof CarrierRejectedError) {
          await this.reject(attemptId, by, error.code, error.message);
        } else {
          this.log.warn(`Carrier request ${attempt.clientReference}: no usable answer`);
          await this.uncertain(attemptId, by);
        }
        return;
      }
      await this.settle(carrier, attemptId, by, outcome);
      return;
    }
    if (attempt.status === 'CREATED') {
      await this.fetchLabels(carrier, attemptId, by);
      return;
    }
    if (attempt.status === 'ACCEPTED' || (attempt.status === 'SENT' && lookup)) {
      let outcome: CarrierPollOutcome;
      try {
        outcome = await this.call((signal) =>
          carrier.poll(
            { clientReference: attempt.clientReference, carrierRef: attempt.carrierRef, request },
            signal,
          ),
        );
      } catch {
        this.log.warn(`Carrier lookup ${attempt.clientReference} failed`);
        await this.schedule(attemptId);
        return;
      }
      await this.settle(carrier, attemptId, by, outcome);
    }
  }

  private async settle(
    carrier: CarrierGateway,
    attemptId: string,
    by: By,
    outcome: CarrierPollOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'PENDING':
        await this.schedule(attemptId);
        return;
      case 'UNKNOWN':
        await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status === 'SENT') {
            await tx.shipmentCarrierRequest.update({
              where: { id: a.id },
              data: { errorMessage: outcome.detail.slice(0, 1000) },
            });
          }
        });
        return;
      case 'REJECTED':
        await this.reject(attemptId, by, outcome.code, outcome.message);
        return;
      case 'NOT_CREATED':
        // Only the carrier's own answer settles this — never the passing of time.
        await this.inAttempt(attemptId, async (tx, a, orderId) => {
          if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: { status: 'NOT_CREATED', resolvedAt: new Date(), nextPollAt: null },
          });
          await tx.shipment.update({ where: { id: a.shipmentId }, data: { status: 'DRAFT' } });
          await shipmentEvent(tx, orderId, 'LABELS_NOT_CREATED', step(by), {
            shipment: a.shipment.code,
          });
        });
        return;
      case 'ACCEPTED': {
        const moved = await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status !== 'SENT') return false;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: {
              status: 'ACCEPTED',
              carrierRef: outcome.carrierRef,
              errorCode: null,
              errorMessage: null,
              nextPollAt: new Date(),
              pollCount: 0,
            },
          });
          return true;
        });
        // One immediate look after the transition; further ones by the background poller.
        if (moved) await this.drive(attemptId, by);
        return;
      }
      case 'CREATED': {
        const recorded = await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status === 'CREATED') return true;
          if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return false;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: {
              status: 'CREATED',
              errorCode: null,
              errorMessage: null,
              nextPollAt: new Date(),
              pollCount: 0,
              result: JSON.parse(
                JSON.stringify({ shipmentRef: outcome.shipmentRef, parcels: outcome.parcels }),
              ),
            },
          });
          return true;
        });
        if (recorded) await this.fetchLabels(carrier, attemptId, by);
      }
    }
  }

  /** The next automatic look at an accepted/created request (bounded, with back-off). */
  private async schedule(attemptId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const a = await tx.shipmentCarrierRequest.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.status !== 'ACCEPTED' && a.status !== 'CREATED') return;
      const count = a.pollCount + 1;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: {
          pollCount: count,
          nextPollAt: count >= MAX_POLLS ? null : new Date(Date.now() + backoff(count) * 1000),
        },
      });
    });
  }

  /** Downloads, checks and stores the labels of a created shipment, then marks it LABELED. */
  private async fetchLabels(carrier: CarrierGateway, attemptId: string, by: By): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const result = attempt.result as {
      shipmentRef: string;
      parcels: CarrierParcelNumber[];
    } | null;
    if (attempt.status !== 'CREATED' || !result) return;
    const request = attempt.payload as unknown as CarrierShipmentRequest;
    const parcels = await this.prisma.shipmentParcel.findMany({
      where: { shipmentId: attempt.shipmentId },
      select: { id: true, parcelNo: true },
      orderBy: { parcelNo: 'asc' },
    });
    // Each parcel number must be proven for exactly one of our parcels — never by position.
    const numbers = new Map(result.parcels.map((p) => [p.parcelNo, p.number]));
    const distinct = new Set(result.parcels.map((p) => p.number));
    if (
      result.parcels.length !== parcels.length ||
      numbers.size !== parcels.length ||
      distinct.size !== parcels.length ||
      parcels.some((p) => !numbers.get(p.parcelNo))
    ) {
      await this.mark(attemptId, 'CARRIER_PARCEL_MISMATCH', 'The carrier returned other parcels');
      return;
    }
    let files: Awaited<ReturnType<CarrierGateway['labels']>>;
    try {
      files = await this.call((signal) =>
        carrier.labels(
          {
            shipmentRef: result.shipmentRef,
            carrierRef: attempt.carrierRef,
            parcels: result.parcels,
            settings: request.settings,
          },
          signal,
        ),
      );
    } catch {
      this.log.warn(`Labels of ${attempt.clientReference} not downloaded`);
      await this.mark(attemptId, 'LABELS_NOT_DOWNLOADED', 'The labels could not be downloaded');
      await this.schedule(attemptId);
      return;
    }
    const perParcel = new Map(files.parcels.map((f) => [f.parcelNo, f]));
    if (
      parcels.some((p) => !perParcel.get(p.parcelNo) || !isLabelFile(perParcel.get(p.parcelNo)!)) ||
      (files.complete !== null && !isLabelFile(files.complete))
    ) {
      await this.mark(attemptId, 'LABELS_INVALID', 'The carrier returned no valid label file');
      return;
    }
    // Stored only after every check passed; files are never replaced or deleted.
    const stored: { parcelId: string | null; file: CarrierLabelFile; key: string }[] = [];
    for (const p of parcels) {
      const file = perParcel.get(p.parcelNo)!;
      stored.push({ parcelId: p.id, file, key: await this.put(file) });
    }
    if (files.complete) {
      stored.push({ parcelId: null, file: files.complete, key: await this.put(files.complete) });
    }
    await this.inAttempt(attemptId, async (tx, a, orderId) => {
      if (a.status !== 'CREATED') return;
      const now = new Date();
      for (const s of stored) {
        await tx.shipmentLabel.create({
          data: {
            shipmentId: a.shipmentId,
            parcelId: s.parcelId,
            requestId: a.id,
            format: s.file.format,
            dpi: s.file.dpi,
            fileKey: s.key,
            sha256: createHash('sha256').update(s.file.bytes).digest('hex'),
            sizeBytes: s.file.bytes.byteLength,
            createdAt: now,
          },
        });
      }
      for (const p of parcels) {
        await tx.shipmentParcel.update({
          where: { id: p.id },
          data: { carrierParcelNumber: numbers.get(p.parcelNo)! },
        });
      }
      await tx.shipment.update({
        where: { id: a.shipmentId },
        data: { status: 'LABELED', carrierShipmentRef: result.shipmentRef, labeledAt: now },
      });
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: {
          status: 'SUCCEEDED',
          resolvedAt: now,
          errorCode: null,
          errorMessage: null,
          nextPollAt: null,
        },
      });
      await shipmentEvent(tx, orderId, 'LABELS_CREATED', step(by), {
        shipment: a.shipment.code,
        parcels: parcels.length,
      });
    });
  }

  private async put(file: CarrierLabelFile): Promise<string> {
    const key = newStorageKey('shipment-labels', file.format === 'PDF' ? 'pdf' : 'zpl');
    await this.storage.put(key, file.bytes);
    return key;
  }

  private async mark(attemptId: string, code: string, message: string): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a) => {
      if (a.status !== 'CREATED') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: { errorCode: code, errorMessage: message },
      });
    });
  }

  private async reject(attemptId: string, by: By, code: string, message: string): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a, orderId) => {
      if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: {
          status: 'REJECTED',
          resolvedAt: new Date(),
          nextPollAt: null,
          errorCode: code.slice(0, 100),
          errorMessage: message.slice(0, 1000),
        },
      });
      await tx.shipment.update({ where: { id: a.shipmentId }, data: { status: 'DRAFT' } });
      await shipmentEvent(tx, orderId, 'LABELS_REJECTED', step(by), {
        shipment: a.shipment.code,
        reason: message.slice(0, 500),
      });
    });
  }

  /** The call ended without a usable answer: recorded, never re-sent. */
  private async uncertain(attemptId: string, by: By): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a, orderId) => {
      if (a.status !== 'SENT') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: { errorCode: NO_ANSWER, errorMessage: 'No usable answer from the carrier' },
      });
      await shipmentEvent(tx, orderId, 'LABELS_UNCERTAIN', step(by), { shipment: a.shipment.code });
    });
  }

  /** Runs `work` with the order and the request locked (order → request). */
  private async inAttempt<R>(
    attemptId: string,
    work: (
      tx: Tx,
      attempt: Prisma.ShipmentCarrierRequestGetPayload<{
        include: { shipment: { select: { code: true; orderId: true } } };
      }>,
      orderId: string,
    ) => Promise<R>,
  ): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.shipmentCarrierRequest.findUniqueOrThrow({
        where: { id: attemptId },
        select: { shipment: { select: { orderId: true } } },
      });
      const orderId = head.shipment.orderId;
      await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      await tx.$executeRaw`SELECT 1 FROM "shipment_carrier_requests" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
      const attempt = await tx.shipmentCarrierRequest.findUniqueOrThrow({
        where: { id: attemptId },
        include: { shipment: { select: { code: true, orderId: true } } },
      });
      return work(tx, attempt, orderId);
    });
  }

  /**
   * Background step: claims due accepted/created requests (SKIP LOCKED, a lease) and moves them
   * forward. Safe with several API processes and after a restart.
   */
  async pollDue(limit = 5): Promise<number> {
    const due = await this.prisma.$queryRaw<
      { id: string; created_by: string; operation_request_id: string }[]
    >`
      UPDATE "shipment_carrier_requests" r SET "next_poll_at" = now() + interval '60 seconds'
       WHERE r."id" IN (SELECT q."id" FROM "shipment_carrier_requests" q
                         WHERE q."status" IN ('ACCEPTED', 'CREATED') AND q."next_poll_at" <= now()
                         ORDER BY q."next_poll_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING r."id", r."created_by", r."operation_request_id"`;
    for (const r of due) {
      try {
        await this.drive(r.id, { actorId: r.created_by, operationId: r.operation_request_id });
      } catch (error) {
        this.log.warn(`Polling ${r.id} failed: ${String(error)}`);
      }
    }
    return due.length;
  }

  // --- cancelling ----------------------------------------------------------------------------

  /**
   * Moves a started cancellation (shipment CANCELLING) forward: asks the carrier (idempotent) or,
   * when it already accepted the request, checks the outcome. Only the carrier's confirmation
   * cancels; its refusal returns the shipment; an unknown answer leaves it for "Ověřit zrušení".
   */
  async driveCancel(shipmentId: string, by: By, check = false): Promise<void> {
    const s = await this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { requests: { where: { status: { in: ['CREATED', 'SUCCEEDED'] } } } },
    });
    if (s.status !== 'CANCELLING') return;
    const carrier = this.gatewayOf(s);
    if (!carrier) return;
    const created = s.requests[0]?.result as {
      shipmentRef: string;
      parcels: CarrierParcelNumber[];
    } | null;
    const shipmentRef = s.carrierShipmentRef ?? created?.shipmentRef;
    if (!shipmentRef) return;
    const query = { shipmentRef, parcels: (created?.parcels ?? []).map((p) => p.number) };
    try {
      if (check || s.carrierCancelSentAt) {
        const status = await this.call((signal) => carrier.cancelStatus(query, signal));
        if (status === 'CANCELLED') return this.finalizeCancel(shipmentId, by);
        if (status === 'NOT_CANCELLED') {
          if (s.carrierCancelSentAt) {
            return this.refuseCancel(shipmentId, by, 'The carrier did not cancel the shipment');
          }
          // The earlier request's answer was lost: asking again is safe (cancelling is idempotent).
        } else {
          return; // PENDING / UNKNOWN: stays CANCELLING
        }
      }
      const answer = await this.call((signal) => carrier.cancel(query, signal));
      if (answer === 'CANCELLED') return this.finalizeCancel(shipmentId, by);
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${s.orderId}::uuid FOR UPDATE`;
        await tx.shipment.updateMany({
          where: { id: shipmentId, status: 'CANCELLING' },
          data: { carrierCancelSentAt: new Date() },
        });
      });
    } catch (error) {
      if (error instanceof CarrierRejectedError) {
        return this.refuseCancel(shipmentId, by, error.message);
      }
      this.log.warn(`Cancellation of ${s.code}: no usable answer`);
    }
  }

  private async finalizeCancel(shipmentId: string, by: By): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${head.orderId}::uuid FOR UPDATE`;
      const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      if (s.status !== 'CANCELLING') return;
      const order = await tx.order.findUniqueOrThrow({ where: { id: s.orderId } });
      const now = new Date();
      // A shipment created but never labelled: its open request is voided with it.
      await tx.shipmentCarrierRequest.updateMany({
        where: { shipmentId, status: 'CREATED' },
        data: { status: 'VOIDED', resolvedAt: now, nextPollAt: null },
      });
      const asked = await tx.orderEvent.findFirst({
        where: { orderId: s.orderId, type: 'SHIPMENT_CANCEL_REQUESTED' },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { payload: true },
      });
      const reason = ((asked?.payload ?? {}) as { reason?: string }).reason ?? 'Zrušeno u dopravce';
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledBy: by.actorId,
          cancelReason: reason,
          carrierCancelledAt: now,
        },
      });
      const at = { ...by, occurredAt: now };
      await shipmentEvent(tx, s.orderId, 'SHIPMENT_CANCELLED', at, { shipment: s.code, reason });
      // The same crates, a fresh draft: the order is ready to be labelled again.
      await this.deriver.derive(tx, order, at);
    });
  }

  private async refuseCancel(shipmentId: string, by: By, message: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${head.orderId}::uuid FOR UPDATE`;
      const s = await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        include: { requests: { where: { status: 'CREATED' }, select: { id: true } } },
      });
      if (s.status !== 'CANCELLING') return;
      await tx.shipment.update({
        where: { id: shipmentId },
        // Back where it was: labelled, or still being resolved (created, labels not stored).
        data: {
          status: s.requests.length > 0 ? 'REQUESTING' : 'LABELED',
          carrierCancelSentAt: null,
        },
      });
      await shipmentEvent(tx, s.orderId, 'SHIPMENT_CANCEL_REFUSED', step(by), {
        shipment: s.code,
        reason: message.slice(0, 500),
      });
    });
  }
}
