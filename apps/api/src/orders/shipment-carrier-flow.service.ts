import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import {
  CARRIERS,
  CarrierProtocolError,
  CarrierRejectedError,
  type CarrierGateway,
  type CarrierLabelFile,
  type CarrierParcelNumber,
  type CarrierPollOutcome,
  type CarrierRegistry,
  type CarrierShipmentRequest,
} from '../carriers/carrier.js';
import { ShipmentDeriver } from './shipment-deriver.service.js';
import { shipmentEvent, type Step } from './shipment-events.js';

type Tx = Prisma.TransactionClient;
type By = { actorId: string; operationId: string };
type Created = { shipmentRef: string; numbers?: string[]; parcels: CarrierParcelNumber[] };

/** The error code of a finished call (or lookup) whose outcome is unknown (never re-sent). */
export const NO_ANSWER = 'NO_ANSWER';
export const UNRESOLVED = ['PREPARED', 'SENT', 'ACCEPTED', 'CREATED'] as const;
/** Bounded automatic polling of an accepted/created request (back-off 10 s … 5 min, in SQL). */
export const MAX_POLLS = 30;
/** While one caller works on a request inline, the poller leaves it alone this long. */
const LEASE_SECONDS = 60;
/** Upper bound of one stored label file. */
const MAX_LABEL_BYTES = 5 * 1024 * 1024;
/** Problems that need a person (or "Ověřit"): automatic polling stops for them. */
const NEEDS_PERSON = new Set(['CARRIER_PARCEL_MISMATCH', 'LABELS_INVALID', 'CARRIER_PARTIAL']);

const step = (by: By): Step => ({ ...by, occurredAt: new Date() });
const lease = () => new Date(Date.now() + LEASE_SECONDS * 1000);

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
 * or created requests (state in the database — a restart continues; every claimed round ends
 * scheduled or stopped), downloading and checking labels before storing them (only while the
 * shipment is REQUESTING), and the asynchronous cancellation. Calls always use the connection
 * recorded on the request and abort after CARRIER_CALL_TIMEOUT_SECONDS.
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
   * in-flight window); ACCEPTED is polled; CREATED gets its labels — or, on an explicit lookup of a
   * created request whose parcels did not match, is looked up again.
   */
  async drive(attemptId: string, by: By, lookup = false): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
      include: { shipment: { select: { status: true } } },
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
    // Labels and lookups belong to a shipment still being resolved — never to one being cancelled.
    if (attempt.shipment.status !== 'REQUESTING') return;
    const relook =
      attempt.status === 'CREATED' && lookup && attempt.errorCode === 'CARRIER_PARCEL_MISMATCH';
    if (attempt.status === 'CREATED' && !relook) {
      await this.fetchLabels(carrier, attemptId, by);
      return;
    }
    if (relook || attempt.status === 'ACCEPTED' || (attempt.status === 'SENT' && lookup)) {
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
      case 'UNKNOWN': {
        const accepted = await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return false;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: {
              // A lookup the carrier cannot answer leaves the request uncertain, never closed.
              errorCode: a.status === 'SENT' ? NO_ANSWER : a.errorCode,
              errorMessage: outcome.detail.slice(0, 1000),
            },
          });
          return a.status === 'ACCEPTED';
        });
        if (accepted) await this.schedule(attemptId);
        return;
      }
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
              nextPollAt: lease(),
              pollCount: 0,
            },
          });
          return true;
        });
        // One immediate look after the transition; still accepted later = still processing.
        if (moved) await this.drive(attemptId, by);
        else await this.schedule(attemptId);
        return;
      }
      case 'CREATED': {
        const recorded = await this.inAttempt(attemptId, async (tx, a, orderId) => {
          const replace = a.status === 'CREATED' && a.errorCode === 'CARRIER_PARCEL_MISMATCH';
          if (a.status === 'CREATED' && !replace) return true;
          if (a.status !== 'SENT' && a.status !== 'ACCEPTED' && !replace) {
            // The carrier created it although the request was closed meanwhile: never silent.
            if (a.status === 'NOT_CREATED' || a.status === 'REJECTED') {
              this.log.error(
                `Carrier created ${outcome.shipmentRef} for closed ${a.clientReference}`,
              );
              await shipmentEvent(tx, orderId, 'CARRIER_LATE_ANSWER', step(by), {
                shipment: a.shipment.code,
                reason: `Dopravce zásilku ${outcome.shipmentRef} vytvořil až po uzavření požadavku ${a.clientReference} – zkontrolujte ji u dopravce.`,
              });
            }
            return false;
          }
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: {
              status: 'CREATED',
              errorCode: outcome.problem?.code.slice(0, 100) ?? null,
              errorMessage: outcome.problem?.message.slice(0, 1000) ?? null,
              nextPollAt: outcome.problem ? null : lease(),
              pollCount: 0,
              result: JSON.parse(
                JSON.stringify({
                  shipmentRef: outcome.shipmentRef,
                  numbers: outcome.numbers,
                  parcels: outcome.parcels,
                }),
              ),
            },
          });
          return true;
        });
        // A partly created shipment never gets labels: it is cancelled at the carrier instead.
        if (recorded && !outcome.problem) await this.fetchLabels(carrier, attemptId, by);
      }
    }
  }

  /** The next automatic look (bounded, back-off, database time); stops after MAX_POLLS. */
  private async schedule(attemptId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "shipment_carrier_requests"
         SET "poll_count" = "poll_count" + 1,
             "next_poll_at" = CASE WHEN "poll_count" + 1 >= ${MAX_POLLS} THEN NULL
                                   ELSE now() + make_interval(secs => LEAST(5 * power(2, "poll_count" + 1), 300)) END
       WHERE "id" = ${attemptId}::uuid AND "status" IN ('ACCEPTED', 'CREATED')`;
  }

  /** Downloads, checks and stores the labels of a created shipment, then marks it LABELED. */
  private async fetchLabels(carrier: CarrierGateway, attemptId: string, by: By): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
      include: { shipment: { select: { status: true } } },
    });
    const result = attempt.result as Created | null;
    if (attempt.status !== 'CREATED' || !result || attempt.shipment.status !== 'REQUESTING') return;
    const request = attempt.payload as unknown as CarrierShipmentRequest;
    const parcels = await this.prisma.shipmentParcel.findMany({
      where: { shipmentId: attempt.shipmentId },
      select: { id: true, parcelNo: true },
      orderBy: { parcelNo: 'asc' },
    });
    // Each parcel number must be proven for exactly one of our parcels — never by position.
    const numbers = new Map(result.parcels.map((p) => [p.parcelNo, p.number]));
    const distinct = new Set(result.parcels.map((p) => p.number));
    // …and every number the carrier created belongs to exactly one parcel (none left over).
    const created = result.numbers ?? result.parcels.map((p) => p.number);
    if (
      created.length !== parcels.length ||
      created.some((n) => !distinct.has(n)) ||
      result.parcels.length !== parcels.length ||
      numbers.size !== parcels.length ||
      distinct.size !== parcels.length ||
      parcels.some((p) => !numbers.get(p.parcelNo))
    ) {
      await this.mark(
        attemptId,
        'CARRIER_PARCEL_MISMATCH',
        'The carrier numbers are not proven per parcel',
      );
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
    } catch (error) {
      if (error instanceof CarrierProtocolError) {
        this.log.error(`Labels of ${attempt.clientReference} refused: ${error.message}`);
        await this.mark(attemptId, 'LABELS_INVALID', error.message);
        return;
      }
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
    // The shipment may have changed meanwhile (e.g. a cancellation started): store nothing then.
    const still = await this.prisma.shipmentCarrierRequest.findUnique({
      where: { id: attemptId },
      select: { status: true, shipment: { select: { status: true } } },
    });
    if (still?.status !== 'CREATED' || still.shipment.status !== 'REQUESTING') return;
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
      const s = await tx.shipment.findUniqueOrThrow({
        where: { id: a.shipmentId },
        select: { status: true },
      });
      if (a.status !== 'CREATED' || s.status !== 'REQUESTING') return;
      const now = new Date();
      for (const x of stored) {
        await tx.shipmentLabel.create({
          data: {
            shipmentId: a.shipmentId,
            parcelId: x.parcelId,
            requestId: a.id,
            format: x.file.format,
            dpi: x.file.dpi,
            fileKey: x.key,
            sha256: createHash('sha256').update(x.file.bytes).digest('hex'),
            sizeBytes: x.file.bytes.byteLength,
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

  /** Records a problem of a created request; those that need a person stop the polling. */
  private async mark(attemptId: string, code: string, message: string): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a) => {
      if (a.status !== 'CREATED') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: {
          errorCode: code,
          errorMessage: message,
          ...(NEEDS_PERSON.has(code) ? { nextPollAt: null } : {}),
        },
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
   * Background step: claims due accepted/created requests of shipments still being resolved
   * (SKIP LOCKED, a lease) and moves them forward. Every claimed round ends scheduled (counted)
   * or stopped — a round that changed nothing is counted like any other look.
   */
  async pollDue(limit = 5): Promise<number> {
    const due = await this.prisma.$queryRaw<
      { id: string; created_by: string; operation_request_id: string; lease: Date }[]
    >`
      UPDATE "shipment_carrier_requests" r
         SET "next_poll_at" = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE r."id" IN (SELECT q."id" FROM "shipment_carrier_requests" q
                          JOIN "shipments" s ON s."id" = q."shipment_id" AND s."status" = 'REQUESTING'
                         WHERE q."status" IN ('ACCEPTED', 'CREATED') AND q."next_poll_at" <= now()
                         ORDER BY q."next_poll_at" LIMIT ${limit} FOR UPDATE OF q SKIP LOCKED)
      RETURNING r."id", r."created_by", r."operation_request_id", r."next_poll_at" AS "lease"`;
    for (const r of due) {
      try {
        await this.drive(r.id, { actorId: r.created_by, operationId: r.operation_request_id });
      } catch (error) {
        this.log.warn(`Polling ${r.id} failed: ${String(error)}`);
      }
      // Untouched by the round (no answer, an exception, …): counted, so polling stays bounded.
      const untouched = await this.prisma.shipmentCarrierRequest.count({
        where: { id: r.id, nextPollAt: r.lease, status: { in: ['ACCEPTED', 'CREATED'] } },
      });
      if (untouched) await this.schedule(r.id);
    }
    return due.length;
  }

  // --- cancelling ----------------------------------------------------------------------------

  /**
   * Moves a started cancellation (shipment CANCELLING) forward: asks the carrier (idempotent) or,
   * when it already accepted the request, checks the outcome. Only the carrier's confirmation
   * cancels; only its definitive refusal returns the shipment; anything else stays CANCELLING for
   * "Ověřit zrušení".
   */
  async driveCancel(shipmentId: string, by: By, check = false): Promise<void> {
    const s = await this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { requests: { where: { status: { in: ['CREATED', 'SUCCEEDED'] } } } },
    });
    if (s.status !== 'CANCELLING') return;
    const carrier = this.gatewayOf(s);
    if (!carrier) return;
    const created = s.requests[0]?.result as Created | null;
    const shipmentRef = s.carrierShipmentRef ?? created?.shipmentRef;
    if (!shipmentRef) return;
    // Every number the carrier created — also those of a partly created set.
    const query = {
      shipmentRef,
      parcels: created?.numbers ?? (created?.parcels ?? []).map((p) => p.number),
    };
    try {
      if (check || s.carrierCancelSentAt) {
        const status = await this.call((signal) => carrier.cancelStatus(query, signal));
        if (status === 'CANCELLED') return await this.finalizeCancel(shipmentId, by);
        if (status === 'NOT_CANCELLED') {
          // Definitive (e.g. already picked up) once the carrier had the request.
          if (s.carrierCancelSentAt) {
            return await this.refuseCancel(
              shipmentId,
              by,
              'The carrier did not cancel the shipment',
            );
          }
          // The earlier request's answer was lost: asking again is safe (cancelling is idempotent).
        } else if (status === 'UNKNOWN' || s.carrierCancelSentAt) {
          return; // the carrier cannot tell, or is processing our request: stays CANCELLING
        }
        // PENDING (nothing cancelled yet) and our request's answer was lost: asking again is
        // safe — the gateway skips numbers already cancelled.
      }
      const answer = await this.call((signal) => carrier.cancel(query, signal));
      if (answer === 'CANCELLED') return await this.finalizeCancel(shipmentId, by);
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${s.orderId}::uuid FOR UPDATE`;
        await tx.shipment.updateMany({
          where: { id: shipmentId, status: 'CANCELLING' },
          data: { carrierCancelSentAt: new Date() },
        });
      });
    } catch (error) {
      if (error instanceof CarrierRejectedError) {
        return await this.refuseCancel(shipmentId, by, error.message);
      }
      this.log.warn(`Cancellation of ${s.code}: no usable answer`);
    }
  }

  private async finalizeCancel(shipmentId: string, by: By): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${head.orderId}::uuid FOR UPDATE`;
      const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      const at = { ...by, occurredAt: new Date() };
      if (s.status !== 'CANCELLING') {
        // A confirmation after the shipment was returned (a concurrent, older refusal): recorded.
        this.log.error(`Carrier confirmed the cancellation of ${s.code} after it was returned`);
        await shipmentEvent(tx, s.orderId, 'CARRIER_LATE_ANSWER', at, {
          shipment: s.code,
          reason: `Dopravce potvrdil zrušení přepravy ${s.code} až po jejím vrácení – zkontrolujte ji u dopravce.`,
        });
        return;
      }
      const order = await tx.order.findUniqueOrThrow({ where: { id: s.orderId } });
      // A shipment created but never labelled: its open request is voided with it.
      await tx.shipmentCarrierRequest.updateMany({
        where: { shipmentId, status: 'CREATED' },
        data: { status: 'VOIDED', resolvedAt: at.occurredAt, nextPollAt: null },
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
          cancelledAt: at.occurredAt,
          cancelledBy: by.actorId,
          cancelReason: reason,
          carrierCancelledAt: at.occurredAt,
        },
      });
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
      // A created request resumes its (bounded) label download.
      await tx.shipmentCarrierRequest.updateMany({
        where: { shipmentId, status: 'CREATED' },
        data: { nextPollAt: new Date(), pollCount: 0 },
      });
      await shipmentEvent(tx, s.orderId, 'SHIPMENT_CANCEL_REFUSED', step(by), {
        shipment: s.code,
        reason: message.slice(0, 500),
      });
    });
  }
}
