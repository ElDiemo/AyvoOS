import type {
  AbandonLabelsRequest,
  CancelShipmentRequest,
  CarrierInfo,
  HandOverRequest,
  MissingData,
  OrderShipment,
  ReadyForPickupRequest,
  RequestLabelsRequest,
  ResolveCancelRequest,
  ResolveLabelsRequest,
  WeighParcelRequest,
} from '@ayvo/types';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { grams } from '../catalog/weights.service.js';
import { CODE_PREFIX, parseCodeSerial } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { CrateCyclesService } from '../crates/crate-cycles.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import {
  CARRIERS,
  type CarrierChoice,
  type CarrierGateway,
  type CarrierRegistry,
  type CarrierSettingsSnapshot,
  type CarrierShipmentRequest,
} from '../carriers/carrier.js';
import { MAX_POLLS, ShipmentCarrierFlow, UNRESOLVED } from './shipment-carrier-flow.service.js';
import { ShipmentDeriver } from './shipment-deriver.service.js';
import { shipmentEvent, type Step } from './shipment-events.js';

type Tx = Prisma.TransactionClient;

const notFound = () => new NotFoundException('Order not found');

/** Strips diacritics for carriers that accept only Latin ASCII (PPL CPL, doc 029 §5). */
export const latin = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Dispatch of a completed order to a carrier (doc 029) — the operations on the order. One
 * shipment per order (the whole order together), one parcel per allocated crate (= one label),
 * derived when picking is completed. The carrier is reached only through
 * {@link ShipmentCarrierFlow} (written request, claimed once, time-limited calls, never re-sent
 * blindly). Nothing here moves stock or means "delivered".
 */
@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly cycles: CrateCyclesService,
    private readonly deriver: ShipmentDeriver,
    private readonly flow: ShipmentCarrierFlow,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(CARRIERS) private readonly carriers: CarrierRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The shipment of a just completed order (in the completion transaction). */
  derive(tx: Tx, order: { id: string; siteId: string }, step: Step): Promise<string> {
    return this.deriver.derive(tx, order, step);
  }

  /**
   * Cancelling the order (doc 028) cancels only a shipment that never reached a carrier. One at
   * the carrier (requested, labelled or being cancelled) blocks it — never silently released.
   */
  async releaseForOrderCancel(tx: Tx, orderId: string, step: Step, reason: string): Promise<void> {
    const live = await this.liveShipment(tx, orderId);
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
    await shipmentEvent(tx, orderId, 'SHIPMENT_CANCELLED', step, { shipment: live.code, reason });
  }

  // --- reading -------------------------------------------------------------------------------

  async view(site: SiteContext, code: string): Promise<OrderShipment> {
    const order = await this.findOrder(this.prisma, code, site.siteId);
    if (!order) throw notFound();
    const rows = await this.prisma.shipment.findMany({
      where: { orderId: order.id },
      include: {
        canceller: { select: { displayName: true } },
        cancelRequester: { select: { displayName: true } },
        labels: { where: { parcelId: null }, select: { format: true, dpi: true, createdAt: true } },
        requests: { orderBy: { attemptNo: 'desc' }, take: 1 },
        parcels: {
          orderBy: { parcelNo: 'asc' },
          include: {
            crate: { select: { code: true } },
            cycle: {
              select: { capacity: true, product: { select: { code: true, name: true } } },
            },
            packageDimension: { select: { lengthMm: true, widthMm: true, heightMm: true } },
            labels: { select: { format: true, dpi: true } },
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
    const choice = await this.carriers.forSite(site.siteId);
    const current = carrierInfo(choice);
    const cancelled = rows
      .filter((r) => r.status === 'CANCELLED')
      .map((r) => ({
        code: r.code,
        cancelledAt: r.cancelledAt!.toISOString(),
        cancelledBy: r.canceller!.displayName,
        reason: r.cancelReason!,
      }));
    const live = rows.find((r) => r.status !== 'CANCELLED') ?? null;
    if (!live) return { carrier: current, shipment: null, cancelled };
    // A shipment already at a carrier is shown with ITS carrier and environment (snapshot).
    const own = this.flow.gatewayOf(live);
    // A draft is shown with the site's current carrier (the next request uses it).
    const carrier: CarrierInfo =
      live.carrierCode && live.status !== 'DRAFT'
        ? own
          ? gatewayInfo(own)
          : {
              ...current,
              configured: false,
              unavailable: 'CONNECTION_UNAVAILABLE',
              code: live.carrierCode,
              environment: live.carrierEnvironment as 'TEST' | 'PRODUCTION',
            }
        : current;
    const parcels = live.parcels.map((p) => {
      const w = p.weighings[0];
      const d = p.packageDimension;
      const label = p.labels[0];
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
        label: label ? { format: label.format as 'PDF' | 'ZPL', dpi: label.dpi } : null,
      };
    });
    const request = live.requests[0] ?? null;
    const asked =
      live.status === 'CANCELLING'
        ? await this.prisma.orderEvent.findFirst({
            where: { orderId: order.id, type: 'SHIPMENT_CANCEL_REQUESTED' },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            select: { payload: true },
          })
        : null;
    const gatewayForMissing = live.status === 'DRAFT' && choice.gateway ? choice : null;
    return {
      carrier: current,
      shipment: {
        code: live.code,
        status: live.status,
        carrier,
        carrierShipmentRef: live.carrierShipmentRef,
        labeledAt: live.labeledAt?.toISOString() ?? null,
        parcels,
        missing: gatewayForMissing
          ? await this.missing(gatewayForMissing.gateway, gatewayForMissing.settings, parcels)
          : [],
        request: request
          ? {
              attemptNo: request.attemptNo,
              status: request.status,
              clientReference: request.clientReference,
              sentAt: request.sentAt?.toISOString() ?? null,
              errorCode: request.errorCode,
              errorMessage: request.errorMessage,
              resolvableAt:
                (request.status === 'SENT' || request.status === 'ACCEPTED') && request.sentAt
                  ? new Date(
                      request.sentAt.getTime() + this.env.CARRIER_SETTLE_SECONDS * 1000,
                    ).toISOString()
                  : null,
            }
          : null,
        cancelRequest:
          live.status === 'CANCELLING' && live.cancelRequestedAt
            ? {
                at: live.cancelRequestedAt.toISOString(),
                by: live.cancelRequester?.displayName ?? '',
                reason: ((asked?.payload ?? {}) as { reason?: string }).reason ?? '',
              }
            : null,
        label: live.labels[0]
          ? {
              format: live.labels[0].format as 'PDF' | 'ZPL',
              dpi: live.labels[0].dpi,
              createdAt: live.labels[0].createdAt.toISOString(),
            }
          : null,
        pollingStopped:
          !!request &&
          (request.status === 'ACCEPTED' || request.status === 'CREATED') &&
          request.nextPollAt === null &&
          request.pollCount >= MAX_POLLS,
        createdAt: live.createdAt.toISOString(),
      },
      cancelled,
    };
  }

  /**
   * A stored label file (re-printing never contacts the carrier): one parcel's own label, or the
   * complete document. Opening or downloading it is not evidence of printing.
   */
  async labelFile(
    site: SiteContext,
    code: string,
    parcelNo: number | null,
  ): Promise<{ bytes: Buffer; filename: string; format: string }> {
    const order = await this.findOrder(this.prisma, code, site.siteId);
    if (!order) throw notFound();
    const live = await this.prisma.shipment.findFirst({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { id: true, code: true },
    });
    const label = live
      ? await this.prisma.shipmentLabel.findFirst({
          where:
            parcelNo === null
              ? { shipmentId: live.id, parcelId: null }
              : { shipmentId: live.id, parcel: { parcelNo } },
          select: { fileKey: true, format: true },
        })
      : null;
    if (!live || !label) throw domainError(404, 'NO_LABELS', 'This label does not exist');
    const ext = label.format === 'ZPL' ? 'zpl' : 'pdf';
    const name = parcelNo === null ? `${live.code}-stitky` : `${live.code}-balik-${parcelNo}`;
    return {
      bytes: await this.storage.get(label.fileKey),
      filename: `${name}.${ext}`,
      format: label.format,
    };
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
            input.correctionOf === null ? 'WEIGHING_EXISTS' : 'WEIGHING_STALE',
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
        await shipmentEvent(tx, order.id, 'PARCEL_WEIGHED', step, {
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
   * "Vytvořit přepravní štítky": writes one carrier request (PREPARED, with the site's current
   * carrier settings as a snapshot) and then sends it once. A repeated click or a concurrent
   * request finds the unresolved one and creates nothing new; a replay never sends again.
   */
  async requestLabels(
    actorId: string,
    site: SiteContext,
    code: string,
    input: RequestLabelsRequest,
  ): Promise<OrderShipment> {
    const choice = await this.carriers.forSite(site.siteId);
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
        if (shipment?.status === 'REQUESTING') {
          const open = await tx.shipmentCarrierRequest.findFirstOrThrow({
            where: { shipmentId: shipment.id, status: { in: [...UNRESOLVED] } },
            select: { id: true },
          });
          return { attemptId: open.id };
        }
        if (shipment?.status === 'LABELED' || shipment?.status === 'CANCELLING') {
          throw domainError(409, 'LABELS_EXIST', 'The labels of this shipment exist already');
        }
        if (!choice.gateway) {
          throw domainErrorWithDetails(
            409,
            'CARRIER_NOT_CONFIGURED',
            'No carrier can take a request at this site',
            { reason: choice.reason },
          );
        }
        const carrier = choice.gateway;
        // Orders completed before doc 029 get their shipment now (the same derivation).
        if (!shipment) {
          await this.deriver.derive(tx, order, step);
          shipment = (await this.liveShipment(tx, order.id))!;
        }
        const attemptNo =
          (await tx.shipmentCarrierRequest.count({ where: { shipmentId: shipment.id } })) + 1;
        const clientReference = `${shipment.code}-${attemptNo}`;
        const payload = await this.payload(
          tx,
          carrier,
          choice.settings,
          order,
          shipment.id,
          clientReference,
        );
        const missing = await this.missing(carrier, choice.settings, payload.view);
        if (missing.length > 0) {
          throw domainErrorWithDetails(
            422,
            'SHIPMENT_DATA_MISSING',
            'The carrier requires data that are not known',
            { missing },
          );
        }
        const snapshot = {
          carrierCode: carrier.code,
          carrierConnection: carrier.connection,
          carrierEnvironment: carrier.environment,
        };
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { status: 'REQUESTING', ...snapshot },
        });
        const row = await tx.shipmentCarrierRequest.create({
          data: {
            shipmentId: shipment.id,
            attemptNo,
            ...snapshot,
            clientReference,
            payload: JSON.parse(JSON.stringify(payload.request)),
            createdAt: step.occurredAt,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await shipmentEvent(tx, order.id, 'LABELS_REQUESTED', step, {
          shipment: shipment.code,
          parcels: payload.request.parcels.length,
        });
        return { attemptId: row.id };
      },
    );
    await this.flow.drive(result.attemptId, { actorId, operationId: input.requestId });
    return this.view(site, code);
  }

  /**
   * "Ověřit u dopravce": sends a never-sent request, polls an accepted one, fetches the labels
   * of a created one, or looks up an uncertain one by its references — only after the in-flight
   * window (database time), never re-sending it.
   */
  async resolve(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ResolveLabelsRequest,
  ): Promise<OrderShipment> {
    const { result } = await this.operations.run(
      'SHIPMENT_LABELS_RESOLVE',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const open = await this.openRequest(tx, order.id);
        if (!this.flow.gatewayOf(open)) {
          throw domainError(
            409,
            'CARRIER_CONNECTION_UNAVAILABLE',
            'The carrier connection of this request is not available on this server',
          );
        }
        if (open.status === 'SENT') await this.assertSettled(tx, open.id);
        return { attemptId: open.id };
      },
    );
    await this.flow.drive(result.attemptId, { actorId, operationId: input.requestId }, true);
    return this.view(site, code);
  }

  /**
   * Exceptional, supervised resolution (`shipments:resolve_uncertain`, reason, audited): a person
   * who checked with the carrier confirms that an uncertain request created nothing. Only after
   * the in-flight window and never for a request the carrier reported as created — a mistake here
   * can lead to a duplicate shipment at the carrier, which the UI states.
   */
  async abandon(
    actorId: string,
    site: SiteContext,
    code: string,
    input: AbandonLabelsRequest,
  ): Promise<OrderShipment> {
    await this.operations.run(
      'SHIPMENT_LABELS_ABANDON',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const open = await this.openRequest(tx, order.id);
        // An accepted request only once its automatic checks ended without an answer.
        const pollingOver =
          open.status === 'ACCEPTED' && open.nextPollAt === null && open.pollCount >= MAX_POLLS;
        if (open.status !== 'SENT' && !pollingOver) {
          throw domainErrorWithDetails(
            409,
            'REQUEST_NOT_ABANDONABLE',
            'Only an uncertain or unanswered request can be closed this way',
            { status: open.status },
          );
        }
        await this.assertSettled(tx, open.id);
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.shipmentCarrierRequest.update({
          where: { id: open.id },
          data: {
            status: 'NOT_CREATED',
            resolvedAt: step.occurredAt,
            nextPollAt: null,
            errorCode: 'CLOSED_BY_PERSON',
            errorMessage: input.reason,
          },
        });
        await tx.shipment.update({ where: { id: open.shipmentId }, data: { status: 'DRAFT' } });
        await shipmentEvent(tx, order.id, 'LABELS_NOT_CREATED', step, {
          shipment: open.shipment.code,
          reason: input.reason,
          manual: true,
        });
        return { code: order.code };
      },
    );
    return this.view(site, code);
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
        await shipmentEvent(tx, order.id, 'READY_FOR_PICKUP', step, { shipment: shipment.code });
        return { code: order.code };
      },
    );
    return this.view(site, code);
  }

  /**
   * "Předáno dopravci": after the real hand-over. The crates' cycles become DISPATCHED (ADR
   * 0021) — not delivered and not at the hotel. A started cancellation has already taken the
   * order back to READY_TO_DISPATCH, so the two can never both happen.
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
          select: { crateId: true, cycleId: true },
          orderBy: { crateId: 'asc' },
        });
        for (const a of held) {
          await this.cycles.lockCrate(tx, a.crateId);
          const cycle = await this.cycles.openCycle(tx, a.crateId, true);
          if (cycle?.id !== a.cycleId) throw new Error('The allocated cycle is not the open one');
          await this.cycles.dispatch(tx, cycle, {
            ...step,
            order: order.code,
            shipment: shipment.code,
          });
        }
        await shipmentEvent(tx, order.id, 'HANDED_TO_CARRIER', step, {
          shipment: shipment.code,
          parcels: held.length,
        });
        return { code: order.code };
      },
    );
    return this.view(site, code);
  }

  /**
   * "Zrušit přípravu přepravy": first recorded (CANCELLING, under the order lock; a ready order
   * goes back to READY_TO_DISPATCH so it cannot be handed over meanwhile), then the carrier is
   * asked. Only its confirmation cancels; then a fresh draft is derived from the same crates. The
   * order, its crates and the stock stay as they are.
   */
  async cancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: CancelShipmentRequest,
  ): Promise<OrderShipment> {
    const { result } = await this.operations.run(
      'SHIPMENT_CANCEL',
      input.requestId,
      { actorId, siteId: site.siteId, code, reason: input.reason },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const shipment = await this.liveShipment(tx, order.id);
        if (!shipment) throw domainError(409, 'SHIPMENT_NOT_AT_CARRIER', 'Nothing to cancel');
        if (shipment.status === 'CANCELLING') return { shipmentId: shipment.id };
        if (order.status !== 'READY_TO_DISPATCH' && order.status !== 'READY_FOR_PICKUP') {
          throw domainErrorWithDetails(
            409,
            'SHIPMENT_NOT_CANCELLABLE',
            'The shipment cannot be cancelled now',
            { status: order.status },
          );
        }
        if (shipment.status === 'DRAFT') {
          throw domainError(409, 'SHIPMENT_NOT_AT_CARRIER', 'Nothing was sent to the carrier');
        }
        if (shipment.status === 'REQUESTING') {
          // A shipment the carrier created (labels not usable) can be cancelled; anything else
          // is first resolved with the carrier.
          const open = await tx.shipmentCarrierRequest.findFirst({
            where: { shipmentId: shipment.id, status: 'CREATED' },
            select: { id: true },
          });
          if (!open) {
            throw domainError(
              409,
              'SHIPMENT_REQUEST_UNRESOLVED',
              'A carrier request is unresolved: check it with the carrier first',
            );
          }
        }
        const carrier = this.flow.gatewayOf(shipment);
        if (!carrier || !carrier.rules.canCancel) {
          throw domainError(
            409,
            'CARRIER_CANCEL_UNSUPPORTED',
            'The carrier cannot cancel this shipment through its interface',
          );
        }
        const step = { actorId, operationId: input.requestId, occurredAt: new Date() };
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            status: 'CANCELLING',
            cancelRequestedAt: step.occurredAt,
            cancelRequestedBy: actorId,
            carrierCancelSentAt: null,
          },
        });
        // A created request stops its label download while the cancellation runs.
        await tx.shipmentCarrierRequest.updateMany({
          where: { shipmentId: shipment.id, status: 'CREATED' },
          data: { nextPollAt: null },
        });
        if (order.status === 'READY_FOR_PICKUP') {
          await tx.order.update({ where: { id: order.id }, data: { status: 'READY_TO_DISPATCH' } });
        }
        await shipmentEvent(tx, order.id, 'SHIPMENT_CANCEL_REQUESTED', step, {
          shipment: shipment.code,
          reason: input.reason,
        });
        return { shipmentId: shipment.id };
      },
    );
    await this.flow.driveCancel(result.shipmentId, { actorId, operationId: input.requestId });
    return this.view(site, code);
  }

  /** "Ověřit zrušení u dopravce": asks the carrier again about a started cancellation. */
  async resolveCancel(
    actorId: string,
    site: SiteContext,
    code: string,
    input: ResolveCancelRequest,
  ): Promise<OrderShipment> {
    const { result } = await this.operations.run(
      'SHIPMENT_CANCEL_RESOLVE',
      input.requestId,
      { actorId, siteId: site.siteId, code },
      async (tx) => {
        const order = await this.lockOrder(tx, code, site.siteId);
        const shipment = await this.liveShipment(tx, order.id);
        if (shipment?.status !== 'CANCELLING') {
          throw domainError(409, 'NOTHING_TO_RESOLVE', 'No cancellation is in progress');
        }
        return { shipmentId: shipment.id };
      },
    );
    await this.flow.driveCancel(result.shipmentId, { actorId, operationId: input.requestId }, true);
    return this.view(site, code);
  }

  // --- helpers -------------------------------------------------------------------------------

  /** Refuses while a claimed request may still be in flight (database time, not this host's). */
  private async assertSettled(tx: Tx, requestId: string): Promise<void> {
    const [row] = await tx.$queryRaw<{ settled: boolean; at: Date | null }[]>`
      SELECT ("sent_at" + make_interval(secs => ${this.env.CARRIER_SETTLE_SECONDS})) <= now() AS settled,
             "sent_at" + make_interval(secs => ${this.env.CARRIER_SETTLE_SECONDS}) AS at
        FROM "shipment_carrier_requests" WHERE "id" = ${requestId}::uuid`;
    if (row && !row.settled) {
      throw domainErrorWithDetails(
        409,
        'REQUEST_IN_FLIGHT',
        'The request may still be in flight: check again later',
        { resolvableAt: row.at?.toISOString() ?? null },
      );
    }
  }

  private async openRequest(tx: Tx, orderId: string) {
    const shipment = await this.liveShipment(tx, orderId);
    const open = shipment
      ? await tx.shipmentCarrierRequest.findFirst({
          where: { shipmentId: shipment.id, status: { in: [...UNRESOLVED] } },
          include: { shipment: { select: { code: true } } },
        })
      : null;
    if (!open) throw domainError(409, 'NOTHING_TO_RESOLVE', 'No carrier request is open');
    return open;
  }

  /**
   * What is sent: the order's address snapshot (Latin-only where the carrier needs it), the
   * sender from the site's carrier settings, and one entry per parcel with its own reference.
   */
  private async payload(
    tx: Tx,
    carrier: CarrierGateway,
    settings: CarrierSettingsSnapshot,
    order: Prisma.OrderGetPayload<object>,
    shipmentId: string,
    clientReference: string,
  ) {
    const parcels = await tx.shipmentParcel.findMany({
      where: { shipmentId },
      orderBy: { parcelNo: 'asc' },
      include: {
        crate: { select: { code: true } },
        packageDimension: { select: { lengthMm: true, widthMm: true, heightMm: true } },
        weighings: { orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
    });
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
    const request: CarrierShipmentRequest = {
      clientReference,
      orderCode: order.code,
      settings,
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
        reference: `${clientReference}-${p.parcelNo}`,
        crate: p.crate.code,
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
    carrier: CarrierGateway,
    settings: CarrierSettingsSnapshot,
    parcels: {
      parcelNo: number;
      weightG?: string | null;
      reference?: { massG: string | null };
      actual?: { massG: string } | null;
      dimensions: unknown;
    }[],
  ): Promise<MissingData[]> {
    const missing: MissingData[] = [];
    if (carrier.rules.senderAddress === 'REQUIRED' && !settings.sender) {
      missing.push({ field: 'SENDER_ADDRESS', parcelNo: null });
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
      select: {
        id: true,
        code: true,
        status: true,
        carrierCode: true,
        carrierConnection: true,
        carrierEnvironment: true,
      },
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
}

function gatewayInfo(g: CarrierGateway): CarrierInfo {
  return {
    configured: true,
    unavailable: null,
    code: g.code,
    name: g.name,
    environment: g.environment,
    parcelWeight: g.rules.parcelWeight,
    parcelDimensions: g.rules.parcelDimensions,
    canCancel: g.rules.canCancel,
  };
}

function carrierInfo(choice: CarrierChoice): CarrierInfo {
  if (choice.gateway) return gatewayInfo(choice.gateway);
  return {
    configured: false,
    unavailable: choice.reason,
    code: null,
    name: null,
    environment: null,
    parcelWeight: null,
    parcelDimensions: null,
    canCancel: false,
  };
}
