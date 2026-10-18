import { createHash } from 'node:crypto';
import type {
  CancelShipmentRequest,
  CarrierInfo,
  HandOverRequest,
  MissingData,
  OrderShipment,
  ReadyForPickupRequest,
  RequestLabelsRequest,
  ResolveLabelsRequest,
  WeighParcelRequest,
} from '@ayvo/types';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WeightsService, grams } from '../catalog/weights.service.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import {
  CARRIERS,
  CarrierRejectedError,
  type CarrierCreateOutcome,
  type CarrierGateway,
  type CarrierPollOutcome,
  type CarrierRegistry,
  type CarrierShipmentRequest,
} from './carriers/carrier.js';

type Step = { actorId: string; operationId: string; occurredAt: Date };
type Tx = Prisma.TransactionClient;

/**
 * A request whose sending may still be in flight (claimed, no answer recorded) is not looked up
 * before this has passed: a lookup during the call could report "nothing created" for a shipment
 * the carrier is creating right now. Carrier adapters must time out well before it.
 */
const IN_FLIGHT_MS = 120_000;
/** The error code that marks a finished call whose answer is unknown. */
const NO_ANSWER = 'NO_ANSWER';
const UNRESOLVED = ['PREPARED', 'SENT', 'ACCEPTED', 'CREATED'] as const;

const notFound = () => new NotFoundException('Order not found');

/**
 * Dispatch of a completed order to a carrier (doc 029). One shipment per order (the whole order
 * together), one parcel per allocated crate (= one label), derived automatically when picking is
 * completed. The carrier is reached only through {@link CarrierGateway}, outside transactions;
 * each attempt is written before it is sent, claimed once, and never re-sent blindly — an unknown
 * answer is looked up by its client reference. Nothing here moves stock or means "delivered".
 */
@Injectable()
export class ShipmentsService {
  private readonly log = new Logger(ShipmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly weights: WeightsService,
    private readonly cycles: CrateCyclesService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(CARRIERS) private readonly carriers: CarrierRegistry,
  ) {}

  // --- derivation (in the caller's transaction) ----------------------------------------------

  /**
   * The shipment of a just completed order: one parcel per active allocation, in loading order,
   * with its calculated reference (Hotovo snapshot, else the references in force now) and the
   * shipping package's dimensions. No carrier is contacted.
   */
  async derive(tx: Tx, order: { id: string; siteId: string }, step: Step): Promise<string> {
    const allocations = await tx.orderCrateAllocation.findMany({
      where: { orderId: order.id, releasedAt: null },
      include: {
        cycle: {
          select: {
            id: true,
            productId: true,
            recipeVersionId: true,
            crateTypeId: true,
            capacity: true,
          },
        },
      },
      orderBy: [{ allocatedAt: 'asc' }, { id: 'asc' }],
    });
    const { first: serial } = await allocateSerials(tx, 'shipment', 1);
    const shipment = await tx.shipment.create({
      data: {
        serial,
        code: formatCode(CODE_PREFIX.shipment, serial),
        orderId: order.id,
        siteId: order.siteId,
        createdAt: step.occurredAt,
        createdBy: step.actorId,
        operationRequestId: step.operationId,
      },
    });
    let parcelNo = 0;
    for (const a of allocations) {
      const ref = await this.weights.parcelReference(tx, a.cycle, step.occurredAt);
      parcelNo += 1;
      await tx.shipmentParcel.create({
        data: {
          shipmentId: shipment.id,
          parcelNo,
          allocationId: a.id,
          crateId: a.crateId,
          cycleId: a.cycleId,
          referenceWeightG: ref.massG,
          referenceSource: ref.source,
          weightSnapshotId: ref.snapshotId,
          packageDimensionId: ref.packageDimensionId,
        },
      });
    }
    await this.event(tx, order.id, 'SHIPMENT_CREATED', step, {
      shipment: shipment.code,
      parcels: allocations.length,
    });
    return shipment.code;
  }

  /**
   * Cancelling the order (doc 028) cancels only a shipment that never reached a carrier. One at
   * the carrier (requested or labelled) must be cancelled first — never silently released.
   */
  async releaseForOrderCancel(tx: Tx, orderId: string, step: Step, reason: string): Promise<void> {
    const live = await tx.shipment.findFirst({
      where: { orderId, status: { not: 'CANCELLED' } },
      select: { id: true, code: true, status: true },
    });
    if (!live) return;
    if (live.status !== 'DRAFT') {
      throw domainErrorWithDetails(
        409,
        'SHIPMENT_AT_CARRIER',
        'The shipment was sent to the carrier: cancel its preparation first',
        { shipment: live.code, status: live.status },
      );
    }
    await tx.shipment.update({
      where: { id: live.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: step.occurredAt,
        cancelledBy: step.actorId,
        cancelReason: reason,
      },
    });
    await this.event(tx, orderId, 'SHIPMENT_CANCELLED', step, { shipment: live.code, reason });
  }

  // --- reading -------------------------------------------------------------------------------

  async view(site: SiteContext, code: string): Promise<OrderShipment> {
    const order = await this.findOrder(this.prisma, code, site.siteId);
    if (!order) throw notFound();
    const rows = await this.prisma.shipment.findMany({
      where: { orderId: order.id },
      include: {
        canceller: { select: { displayName: true } },
        labels: { select: { format: true, createdAt: true } },
        requests: { orderBy: { attemptNo: 'desc' }, take: 1 },
        parcels: {
          orderBy: { parcelNo: 'asc' },
          include: {
            crate: { select: { code: true } },
            cycle: {
              select: { capacity: true, product: { select: { code: true, name: true } } },
            },
            packageDimension: { select: { lengthMm: true, widthMm: true, heightMm: true } },
            weighings: {
              orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              include: { recorder: { select: { displayName: true } } },
            },
          },
        },
      },
      orderBy: { serial: 'desc' },
    });
    const live = rows.find((r) => r.status !== 'CANCELLED') ?? null;
    const carrier = this.carriers.forSite(site.siteId);
    const cancelled = rows
      .filter((r) => r.status === 'CANCELLED')
      .map((r) => ({
        code: r.code,
        cancelledAt: r.cancelledAt!.toISOString(),
        cancelledBy: r.canceller!.displayName,
        reason: r.cancelReason!,
      }));
    if (!live) return { shipment: null, cancelled };
    const parcels = live.parcels.map((p) => {
      const w = p.weighings[0];
      const d = p.packageDimension;
      return {
        parcelNo: p.parcelNo,
        crate: p.crate.code,
        product: p.cycle.product,
        bottles: p.cycle.capacity,
        reference: {
          massG: p.referenceWeightG ? grams(p.referenceWeightG) : null,
          source: p.referenceSource,
        },
        actual: w
          ? {
              id: w.id,
              massG: grams(w.massG),
              recordedAt: w.recordedAt.toISOString(),
              recordedBy: w.recorder.displayName,
            }
          : null,
        dimensions:
          d && d.lengthMm !== null && d.widthMm !== null && d.heightMm !== null
            ? { lengthMm: d.lengthMm, widthMm: d.widthMm, heightMm: d.heightMm }
            : null,
        carrierParcelNumber: p.carrierParcelNumber,
      };
    });
    const request = live.requests[0] ?? null;
    return {
      shipment: {
        code: live.code,
        status: live.status,
        carrier: carrierInfo(carrier),
        carrierShipmentRef: live.carrierShipmentRef,
        labeledAt: live.labeledAt?.toISOString() ?? null,
        parcels,
        missing: carrier ? await this.missing(this.prisma, carrier, site.siteId, parcels) : [],
        request: request
          ? {
              attemptNo: request.attemptNo,
              status: request.status,
              clientReference: request.clientReference,
              sentAt: request.sentAt?.toISOString() ?? null,
              errorCode: request.errorCode,
              errorMessage: request.errorMessage,
            }
          : null,
        label: live.labels[0]
          ? { format: 'PDF' as const, createdAt: live.labels[0].createdAt.toISOString() }
          : null,
        createdAt: live.createdAt.toISOString(),
      },
      cancelled,
    };
  }

  /** The stored label document (re-printing never contacts the carrier). */
  async labelFile(site: SiteContext, code: string): Promise<{ bytes: Buffer; filename: string }> {
    const order = await this.findOrder(this.prisma, code, site.siteId);
    if (!order) throw notFound();
    const live = await this.prisma.shipment.findFirst({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { code: true, labels: { select: { fileKey: true } } },
    });
    const key = live?.labels[0]?.fileKey;
    if (!key) throw domainError(404, 'NO_LABELS', 'This shipment has no labels yet');
    return { bytes: await this.storage.get(key), filename: `${live.code}-stitky.pdf` };
  }

  // --- actual weighing -----------------------------------------------------------------------

  async weigh(
    actorId: string,
    site: SiteContext,
    code: string,
    parcelNo: number,
    input: WeighParcelRequest,
  ): Promise<OrderShipment> {
    await this.operations.run(
      'SHIPMENT_PARCEL_WEIGH',
      input.requestId,
      { actorId, siteId: site.siteId, code, parcelNo, ...input, requestId: undefined },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const shipment = await this.liveShipment(tx, order.id);
        if (!shipment || shipment.status !== 'DRAFT') {
          throw domainError(
            409,
            'SHIPMENT_NOT_EDITABLE',
            'Parcels are weighed only before the labels are requested',
          );
        }
        const parcel = await tx.shipmentParcel.findUnique({
          where: { shipmentId_parcelNo: { shipmentId: shipment.id, parcelNo } },
          select: {
            id: true,
            crate: { select: { code: true } },
            weighings: { orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 1 },
          },
        });
        if (!parcel) throw new NotFoundException('Parcel not found');
        const latest = parcel.weighings[0] ?? null;
        // A weighing is never overwritten silently: replacing one is a correction of the latest.
        if (latest && input.correctionOf !== latest.id) {
          throw domainError(
            409,
            latest && input.correctionOf === null ? 'WEIGHING_EXISTS' : 'WEIGHING_STALE',
            'This parcel was weighed already: correct its latest weighing',
          );
        }
        if (!latest && input.correctionOf !== null) {
          throw domainError(409, 'WEIGHING_STALE', 'There is no weighing to correct');
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.shipmentParcelWeighing.create({
          data: {
            parcelId: parcel.id,
            massG: new Prisma.Decimal(input.massG),
            recordedAt: step.occurredAt,
            recordedBy: actorId,
            operationRequestId: input.requestId,
            correctionOfId: input.correctionOf,
            correctionReason: input.correctionReason,
          },
        });
        await this.event(tx, order.id, 'PARCEL_WEIGHED', step, {
          shipment: shipment.code,
          crate: parcel.crate.code,
          reason: input.correctionReason ?? undefined,
        });
        return { code: order.code };
      },
    );
    return this.view(site, code);
  }

  // --- carrier labels ------------------------------------------------------------------------

  /**
   * "Vytvořit přepravní štítky": writes one carrier request (PREPARED) and then sends it once.
   * A repeated click or a concurrent request finds the unresolved one and creates nothing new;
   * a replay of the same request id never sends again.
   */
  async requestLabels(
    actorId: string,
    site: SiteContext,
    code: string,
    input: RequestLabelsRequest,
  ): Promise<OrderShipment> {
    const carrier = this.carriers.forSite(site.siteId);
    if (!carrier) {
      throw domainError(
        409,
        'CARRIER_NOT_CONFIGURED',
        'No carrier is configured for this site: labels cannot be created',
      );
    }
    const { result } = await this.operations.run(
      'SHIPMENT_LABELS_REQUEST',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'READY_TO_DISPATCH') {
          throw domainErrorWithDetails(
            409,
            'ORDER_NOT_READY_TO_DISPATCH',
            'Labels are created for a completed order that is not yet ready for pickup',
            { status: order.status },
          );
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        let shipment = await this.liveShipment(tx, order.id);
        // Orders completed before doc 029 get their shipment now (the same derivation).
        if (!shipment) {
          await this.derive(tx, order, step);
          shipment = (await this.liveShipment(tx, order.id))!;
        }
        if (shipment.status === 'REQUESTING') {
          const open = await tx.shipmentCarrierRequest.findFirstOrThrow({
            where: { shipmentId: shipment.id, status: { in: [...UNRESOLVED] } },
            select: { id: true },
          });
          return { attemptId: open.id };
        }
        if (shipment.status === 'LABELED') {
          throw domainError(409, 'LABELS_EXIST', 'The labels of this shipment exist already');
        }
        const payload = await this.payload(tx, carrier, order, shipment);
        const missing = await this.missing(tx, carrier, site.siteId, payload.view);
        if (missing.length > 0) {
          throw domainErrorWithDetails(
            422,
            'SHIPMENT_DATA_MISSING',
            'The carrier requires data that are not known',
            { missing },
          );
        }
        const attempts = await tx.shipmentCarrierRequest.count({
          where: { shipmentId: shipment.id },
        });
        const attemptNo = attempts + 1;
        const clientReference = `${shipment.code}-${attemptNo}`;
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { status: 'REQUESTING', carrierCode: carrier.code },
        });
        const request = { ...payload.request, clientReference };
        const row = await tx.shipmentCarrierRequest.create({
          data: {
            shipmentId: shipment.id,
            attemptNo,
            carrierCode: carrier.code,
            clientReference,
            payload: JSON.parse(JSON.stringify(request)),
            createdAt: step.occurredAt,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await this.event(tx, order.id, 'LABELS_REQUESTED', step, {
          shipment: shipment.code,
          parcels: payload.request.parcels.length,
        });
        return { attemptId: row.id };
      },
    );
    await this.drive(result.attemptId, { actorId, operationId: input.requestId });
    return this.view(site, code);
  }

  /**
   * "Ověřit u dopravce": settles an unresolved request — sends a never-sent one, looks up an
   * uncertain or accepted one by its references, or fetches the labels of a created one. Never
   * re-sends a request that may have reached the carrier.
   */
  async resolve(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ResolveLabelsRequest,
  ): Promise<OrderShipment> {
    if (!this.carriers.forSite(site.siteId)) {
      throw domainError(409, 'CARRIER_NOT_CONFIGURED', 'No carrier is configured for this site');
    }
    const { result } = await this.operations.run(
      'SHIPMENT_LABELS_RESOLVE',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const shipment = await this.liveShipment(tx, order.id);
        const open = shipment
          ? await tx.shipmentCarrierRequest.findFirst({
              where: { shipmentId: shipment.id, status: { in: [...UNRESOLVED] } },
              select: { id: true, status: true, sentAt: true, errorCode: true },
            })
          : null;
        if (!open) throw domainError(409, 'NOTHING_TO_RESOLVE', 'No carrier request is open');
        if (
          open.status === 'SENT' &&
          open.errorCode !== NO_ANSWER &&
          Date.now() - open.sentAt!.getTime() < IN_FLIGHT_MS
        ) {
          throw domainError(
            409,
            'REQUEST_IN_FLIGHT',
            'The request is still being sent: check again in a moment',
          );
        }
        return { attemptId: open.id };
      },
    );
    await this.drive(result.attemptId, { actorId, operationId: input.requestId }, true);
    return this.view(site, code);
  }

  /**
   * Moves one request forward. PREPARED is claimed (status SENT) by exactly one caller before
   * the carrier is called; everything after the call is recorded in its own transaction.
   */
  private async drive(
    attemptId: string,
    by: { actorId: string; operationId: string },
    lookup = false,
  ): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
      include: { shipment: { select: { siteId: true } } },
    });
    const carrier = this.carriers.forSite(attempt.shipment.siteId);
    if (!carrier || carrier.code !== attempt.carrierCode) return;
    if (attempt.status === 'PREPARED') {
      const claimed = await this.prisma.$executeRaw`
        UPDATE "shipment_carrier_requests" SET "status" = 'SENT', "sent_at" = now()
         WHERE "id" = ${attemptId}::uuid AND "status" = 'PREPARED'`;
      if (claimed !== 1) return; // someone else is sending it
      let outcome: CarrierCreateOutcome;
      try {
        outcome = await carrier.create(attempt.payload as unknown as CarrierShipmentRequest);
      } catch (error) {
        if (error instanceof CarrierRejectedError) {
          await this.reject(attemptId, by, error.code, error.message);
        } else {
          this.log.warn(`Carrier request ${attempt.clientReference}: no answer (${String(error)})`);
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
        outcome = await carrier.poll({
          clientReference: attempt.clientReference,
          carrierRef: attempt.carrierRef,
        });
      } catch (error) {
        this.log.warn(`Carrier lookup ${attempt.clientReference} failed (${String(error)})`);
        return;
      }
      await this.settle(carrier, attemptId, by, outcome);
    }
  }

  private async settle(
    carrier: CarrierGateway,
    attemptId: string,
    by: { actorId: string; operationId: string },
    outcome: CarrierPollOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'PENDING':
      case 'UNKNOWN':
        return;
      case 'REJECTED':
        await this.reject(attemptId, by, outcome.code, outcome.message);
        return;
      case 'NOT_CREATED':
        await this.inAttempt(attemptId, async (tx, a, order) => {
          // Only an uncertain request can be confirmed "never created".
          if (a.status !== 'SENT') return;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: { status: 'NOT_CREATED', resolvedAt: new Date() },
          });
          await tx.shipment.update({ where: { id: a.shipmentId }, data: { status: 'DRAFT' } });
          await this.event(tx, order.id, 'LABELS_NOT_CREATED', this.step(by), {
            shipment: a.shipment.code,
          });
        });
        return;
      case 'ACCEPTED':
        await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status !== 'SENT') return;
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: { status: 'ACCEPTED', carrierRef: outcome.carrierRef, errorCode: null },
          });
        });
        // One immediate look; later ones through "Ověřit u dopravce".
        await this.drive(attemptId, by);
        return;
      case 'CREATED': {
        const recorded = await this.inAttempt(attemptId, async (tx, a) => {
          if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return a.status === 'CREATED';
          await tx.shipmentCarrierRequest.update({
            where: { id: a.id },
            data: {
              status: 'CREATED',
              errorCode: null,
              result: { shipmentRef: outcome.shipmentRef, parcels: outcome.parcels },
            },
          });
          return true;
        });
        if (recorded) await this.fetchLabels(carrier, attemptId, by);
      }
    }
  }

  /** Downloads and stores the labels of a created shipment, then marks it LABELED. */
  private async fetchLabels(
    carrier: CarrierGateway,
    attemptId: string,
    by: { actorId: string; operationId: string },
  ): Promise<void> {
    const attempt = await this.prisma.shipmentCarrierRequest.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const result = attempt.result as {
      shipmentRef: string;
      parcels: { parcelNo: number; number: string }[];
    } | null;
    if (attempt.status !== 'CREATED' || !result) return;
    let bytes: Uint8Array;
    try {
      bytes = await carrier.labels({
        shipmentRef: result.shipmentRef,
        carrierRef: attempt.carrierRef,
      });
    } catch (error) {
      this.log.warn(`Labels of ${attempt.clientReference} not downloaded (${String(error)})`);
      return;
    }
    const key = newStorageKey('shipment-labels', 'pdf');
    await this.storage.put(key, bytes);
    await this.inAttempt(attemptId, async (tx, a, order) => {
      if (a.status !== 'CREATED') return;
      const parcels = await tx.shipmentParcel.findMany({
        where: { shipmentId: a.shipmentId },
        select: { id: true, parcelNo: true },
      });
      const numbers = new Map(result.parcels.map((p) => [p.parcelNo, p.number]));
      if (parcels.length !== numbers.size || parcels.some((p) => !numbers.get(p.parcelNo))) {
        // The carrier's answer does not match the parcels: a person has to look at it.
        await tx.shipmentCarrierRequest.update({
          where: { id: a.id },
          data: {
            errorCode: 'CARRIER_PARCEL_MISMATCH',
            errorMessage: 'The carrier returned other parcels than were sent',
          },
        });
        return;
      }
      await tx.shipmentLabel.create({
        data: {
          shipmentId: a.shipmentId,
          requestId: a.id,
          format: 'PDF',
          fileKey: key,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          createdAt: new Date(),
        },
      });
      for (const p of parcels) {
        await tx.shipmentParcel.update({
          where: { id: p.id },
          data: { carrierParcelNumber: numbers.get(p.parcelNo)! },
        });
      }
      const now = new Date();
      await tx.shipment.update({
        where: { id: a.shipmentId },
        data: { status: 'LABELED', carrierShipmentRef: result.shipmentRef, labeledAt: now },
      });
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: { status: 'SUCCEEDED', resolvedAt: now, errorCode: null, errorMessage: null },
      });
      await this.event(tx, order.id, 'LABELS_CREATED', this.step(by), {
        shipment: a.shipment.code,
        parcels: parcels.length,
      });
    });
  }

  private async reject(
    attemptId: string,
    by: { actorId: string; operationId: string },
    code: string,
    message: string,
  ): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a, order) => {
      if (a.status !== 'SENT' && a.status !== 'ACCEPTED') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: {
          status: 'REJECTED',
          resolvedAt: new Date(),
          errorCode: code.slice(0, 100),
          errorMessage: message.slice(0, 1000),
        },
      });
      await tx.shipment.update({ where: { id: a.shipmentId }, data: { status: 'DRAFT' } });
      await this.event(tx, order.id, 'LABELS_REJECTED', this.step(by), {
        shipment: a.shipment.code,
        reason: message.slice(0, 500),
      });
    });
  }

  /** The call ended without a usable answer: recorded, never re-sent. */
  private async uncertain(
    attemptId: string,
    by: { actorId: string; operationId: string },
  ): Promise<void> {
    await this.inAttempt(attemptId, async (tx, a, order) => {
      if (a.status !== 'SENT') return;
      await tx.shipmentCarrierRequest.update({
        where: { id: a.id },
        data: { errorCode: NO_ANSWER, errorMessage: 'No answer from the carrier' },
      });
      await this.event(tx, order.id, 'LABELS_UNCERTAIN', this.step(by), {
        shipment: a.shipment.code,
      });
    });
  }

  /** Runs `work` with the order and the attempt locked (order → shipment → request). */
  private async inAttempt<R>(
    attemptId: string,
    work: (
      tx: Tx,
      attempt: Prisma.ShipmentCarrierRequestGetPayload<{
        include: { shipment: { select: { code: true; orderId: true } } };
      }>,
      order: { id: string },
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
      return work(tx, attempt, { id: orderId });
    });
  }

  // --- physical milestones -------------------------------------------------------------------

  /** "Připraveno k vyzvednutí": the operator confirms the labels are printed and applied. */
  async readyForPickup(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ReadyForPickupRequest,
  ): Promise<OrderShipment> {
    await this.operations.run(
      'ORDER_READY_FOR_PICKUP',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'READY_TO_DISPATCH') {
          throw domainErrorWithDetails(409, 'ORDER_NOT_READY_TO_DISPATCH', 'Not possible now', {
            status: order.status,
          });
        }
        const shipment = await this.liveShipment(tx, order.id);
        if (shipment?.status !== 'LABELED') {
          throw domainError(409, 'LABELS_NOT_READY', 'The carrier labels do not exist yet');
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.order.update({ where: { id: order.id }, data: { status: 'READY_FOR_PICKUP' } });
        await this.event(tx, order.id, 'READY_FOR_PICKUP', step, { shipment: shipment.code });
        return { code: order.code };
      },
    );
    return this.view(site, code);
  }

  /**
   * "Předáno dopravci": after the real hand-over. The crates' cycles become DISPATCHED (ADR
   * 0021) — not delivered and not at the hotel.
   */
  async handOver(
    actorId: string,
    site: SiteContext,
    code: string,
    input: HandOverRequest,
  ): Promise<OrderShipment> {
    await this.operations.run(
      'ORDER_HAND_OVER',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        if (order.status !== 'READY_FOR_PICKUP') {
          throw domainErrorWithDetails(
            409,
            'ORDER_NOT_READY_FOR_PICKUP',
            'Only an order ready for pickup is handed over',
            { status: order.status },
          );
        }
        const shipment = (await this.liveShipment(tx, order.id))!;
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.order.update({ where: { id: order.id }, data: { status: 'HANDED_TO_CARRIER' } });
        const held = await tx.orderCrateAllocation.findMany({
          where: { orderId: order.id, releasedAt: null },
          select: { crateId: true },
          orderBy: { crateId: 'asc' },
        });
        for (const a of held) {
          await this.cycles.lockCrate(tx, a.crateId);
          const cycle = await this.cycles.openCycle(tx, a.crateId, true);
          await this.cycles.dispatch(tx, cycle!, {
            ...step,
            order: order.code,
            shipment: shipment.code,
          });
        }
        await this.event(tx, order.id, 'HANDED_TO_CARRIER', step, {
          shipment: shipment.code,
          parcels: held.length,
        });
        return { code: order.code };
      },
    );
    return this.view(site, code);
  }

  /**
   * "Zrušit přípravu přepravy": a labelled shipment is cancelled only when the carrier confirms
   * it; then a fresh draft is derived (same crates) and the order is ready to dispatch again. The
   * order, its crates and the stock stay as they are.
   */
  async cancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: CancelShipmentRequest,
  ): Promise<OrderShipment> {
    const order = await this.findOrder(this.prisma, code, site.siteId);
    if (!order) throw notFound();
    const replay = await this.prisma.operationRequest.findUnique({
      where: { requestId: input.requestId },
      select: { result: true },
    });
    let carrierCancelled = false;
    const live = await this.prisma.shipment.findFirst({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { status: true, carrierCode: true, carrierShipmentRef: true },
    });
    if (!replay?.result && live?.status === 'LABELED') {
      const carrier = this.carriers.forSite(site.siteId);
      if (!carrier || carrier.code !== live.carrierCode || !carrier.rules.canCancel) {
        throw domainError(
          409,
          'CARRIER_CANCEL_UNSUPPORTED',
          'The carrier cannot cancel this shipment through its interface',
        );
      }
      try {
        await carrier.cancel({ shipmentRef: live.carrierShipmentRef! });
      } catch (error) {
        if (error instanceof CarrierRejectedError) {
          throw domainErrorWithDetails(409, 'CARRIER_CANCEL_REFUSED', 'The carrier refused', {
            message: error.message,
          });
        }
        throw domainError(
          502,
          'CARRIER_UNAVAILABLE',
          'The carrier did not confirm the cancellation: nothing was changed here',
        );
      }
      carrierCancelled = true;
    }
    await this.operations.run(
      'SHIPMENT_CANCEL',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        const locked = await this.lockOrder(tx, code, site.siteId);
        const shipment = await this.liveShipment(tx, locked.id);
        if (!shipment || shipment.status === 'DRAFT') {
          throw domainError(409, 'SHIPMENT_NOT_AT_CARRIER', 'Nothing was sent to the carrier');
        }
        if (shipment.status === 'REQUESTING') {
          throw domainError(
            409,
            'SHIPMENT_REQUEST_UNRESOLVED',
            'A carrier request is unresolved: check it with the carrier first',
          );
        }
        if (
          !carrierCancelled ||
          !['READY_TO_DISPATCH', 'READY_FOR_PICKUP'].includes(locked.status)
        ) {
          throw domainErrorWithDetails(
            409,
            'SHIPMENT_NOT_CANCELLABLE',
            'The shipment cannot be cancelled now',
            { status: locked.status },
          );
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: step.occurredAt,
            cancelledBy: actorId,
            cancelReason: input.reason,
            carrierCancelledAt: step.occurredAt,
          },
        });
        if (locked.status === 'READY_FOR_PICKUP') {
          await tx.order.update({
            where: { id: locked.id },
            data: { status: 'READY_TO_DISPATCH' },
          });
        }
        await this.event(tx, locked.id, 'SHIPMENT_CANCELLED', step, {
          shipment: shipment.code,
          reason: input.reason,
        });
        await this.derive(tx, locked, step);
        return { code: locked.code };
      },
    );
    return this.view(site, code);
  }

  // --- helpers -------------------------------------------------------------------------------

  /** What is sent: the order's address snapshot, the site as sender, one entry per parcel. */
  private async payload(
    tx: Tx,
    carrier: CarrierGateway,
    order: Prisma.OrderGetPayload<object>,
    shipment: { id: string },
  ) {
    const parcels = await tx.shipmentParcel.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { parcelNo: 'asc' },
      include: {
        crate: { select: { code: true } },
        packageDimension: { select: { lengthMm: true, widthMm: true, heightMm: true } },
        weighings: { orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
    });
    const site = await tx.site.findUniqueOrThrow({ where: { id: order.siteId } });
    const view = parcels.map((p) => {
      const d = p.packageDimension;
      return {
        parcelNo: p.parcelNo,
        weightG: p.weighings[0]
          ? grams(p.weighings[0].massG)
          : p.referenceWeightG
            ? grams(p.referenceWeightG)
            : null,
        dimensions:
          d && d.lengthMm !== null && d.widthMm !== null && d.heightMm !== null
            ? { lengthMm: d.lengthMm, widthMm: d.widthMm, heightMm: d.heightMm }
            : null,
      };
    });
    const sender =
      site.addressLine1 && site.postalCode && site.city
        ? {
            name: site.name,
            addressLine1: site.addressLine1,
            addressLine2: site.addressLine2,
            postalCode: site.postalCode,
            city: site.city,
            countryCode: site.countryCode,
          }
        : null;
    const request: Omit<CarrierShipmentRequest, 'clientReference'> = {
      orderCode: order.code,
      sender: carrier.rules.senderAddress === 'NOT_USED' ? null : sender,
      recipient: {
        name: order.hotelName,
        addressLine1: order.addressLine1,
        addressLine2: order.addressLine2,
        postalCode: order.postalCode,
        city: order.city,
        countryCode: order.countryCode,
        contactName: order.contactName,
        phone: order.contactPhone,
        email: order.contactEmail,
      },
      parcels: parcels.map((p, i) => ({
        parcelNo: p.parcelNo,
        reference: p.crate.code,
        weightG: carrier.rules.parcelWeight === 'NOT_USED' ? null : view[i]!.weightG,
        dimensionsMm:
          carrier.rules.parcelDimensions === 'NOT_USED' || !view[i]!.dimensions
            ? null
            : {
                length: view[i]!.dimensions!.lengthMm,
                width: view[i]!.dimensions!.widthMm,
                height: view[i]!.dimensions!.heightMm,
              },
      })),
    };
    return { request, view };
  }

  /** Data the carrier requires and that are unknown — shown, never replaced by 0 or a guess. */
  private async missing(
    db: Tx,
    carrier: CarrierGateway,
    siteId: string,
    parcels: {
      parcelNo: number;
      weightG?: string | null;
      reference?: { massG: string | null };
      actual?: { massG: string } | null;
      dimensions: unknown;
    }[],
  ): Promise<MissingData[]> {
    const missing: MissingData[] = [];
    if (carrier.rules.senderAddress === 'REQUIRED') {
      const site = await db.site.findUniqueOrThrow({ where: { id: siteId } });
      if (!site.addressLine1 || !site.postalCode || !site.city) {
        missing.push({ field: 'SENDER_ADDRESS', parcelNo: null });
      }
    }
    for (const p of parcels) {
      const weight = p.weightG ?? p.actual?.massG ?? p.reference?.massG ?? null;
      if (carrier.rules.parcelWeight === 'REQUIRED' && !weight) {
        missing.push({ field: 'PARCEL_WEIGHT', parcelNo: p.parcelNo });
      }
      if (carrier.rules.parcelDimensions === 'REQUIRED' && !p.dimensions) {
        missing.push({ field: 'PARCEL_DIMENSIONS', parcelNo: p.parcelNo });
      }
    }
    return missing;
  }

  private liveShipment(tx: Tx, orderId: string) {
    return tx.shipment.findFirst({
      where: { orderId, status: { not: 'CANCELLED' } },
      select: { id: true, code: true, status: true },
    });
  }

  private async lockOrder(tx: Tx, code: string, siteId: string) {
    const found = await this.findOrder(tx, code, siteId);
    if (!found) throw notFound();
    await tx.$executeRaw`SELECT 1 FROM "orders" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    return tx.order.findUniqueOrThrow({ where: { id: found.id } });
  }

  private findOrder(db: Tx, code: string, siteId: string) {
    const serial = parseCodeSerial(CODE_PREFIX.order, code);
    if (serial === null) return Promise.resolve(null);
    return db.order.findFirst({ where: { serial, siteId }, select: { id: true } });
  }

  private step(by: { actorId: string; operationId: string }): Step {
    return { ...by, occurredAt: new Date() };
  }

  private async event(
    tx: Tx,
    orderId: string,
    type:
      | 'SHIPMENT_CREATED'
      | 'LABELS_REQUESTED'
      | 'LABELS_CREATED'
      | 'LABELS_REJECTED'
      | 'LABELS_UNCERTAIN'
      | 'LABELS_NOT_CREATED'
      | 'PARCEL_WEIGHED'
      | 'READY_FOR_PICKUP'
      | 'HANDED_TO_CARRIER'
      | 'SHIPMENT_CANCELLED',
    step: Step,
    payload: { shipment: string; parcels?: number; crate?: string; reason?: string },
  ): Promise<void> {
    await tx.orderEvent.create({
      data: {
        orderId,
        type,
        occurredAt: step.occurredAt,
        actorId: step.actorId,
        operationRequestId: step.operationId,
        payload: JSON.parse(JSON.stringify(payload)),
      },
    });
  }
}

function carrierInfo(carrier: CarrierGateway | null): CarrierInfo {
  if (!carrier) {
    return {
      configured: false,
      code: null,
      name: null,
      parcelWeight: null,
      parcelDimensions: null,
      canCancel: false,
    };
  }
  return {
    configured: true,
    code: carrier.code,
    name: carrier.name,
    parcelWeight: carrier.rules.parcelWeight,
    parcelDimensions: carrier.rules.parcelDimensions,
    canCancel: carrier.rules.canCancel,
  };
}
