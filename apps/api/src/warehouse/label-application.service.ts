import { Inject, Injectable } from '@nestjs/common';
import type { LabelApplicationRequest, LabelApplicationResult } from '@ayvo/types';
import { BottlesService } from '../assets/bottles.service.js';
import { domainError } from '../common/domain-error.js';
import { formatQuantity } from '../common/quantity.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { byLockOrder, InventoryService } from '../inventory/inventory.service.js';
import { LabelPrintJobsService } from '../label-production/label-print-jobs.service.js';

interface StoredOutcome {
  outcome: 'APPLIED' | 'ALREADY_APPLIED';
  bottleId: string;
  eventId: string;
  [key: string]: string;
}

/**
 * Physical label application (doc 018 §7, doc 019): the production scan after a printed QR label
 * has been stuck on a new bottle body. One transaction: bottle CREATED → LABELED_EMPTY,
 * LABEL_APPLIED event, LABEL component attachment, and the consumption of exactly one new bottle
 * from the lot the operator selected for the session (never another lot, never a guess). The
 * session also names the bottle series being labelled; a bottle of another series is refused
 * (WRONG_SERIES).
 *
 * Lock order: operation request → bottle → balance rows (ascending item, location, lot).
 */
@Injectable()
export class LabelApplicationService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly operations: OperationRequestsService,
    private readonly bottles: BottlesService,
    private readonly printJobs: LabelPrintJobsService,
    private readonly inventory: InventoryService,
  ) {}

  async apply(request: LabelApplicationRequest): Promise<LabelApplicationResult> {
    const scan = classifyScannedQr(request.scannedValue, this.env.PUBLIC_QR_BASE_URL);
    if (scan.kind === 'NOT_AYVO_QR') {
      throw domainError(422, 'NOT_AYVO_QR', 'This is not an AYVO bottle label of this environment');
    }
    if (scan.kind === 'WRONG_ENVIRONMENT') {
      throw domainError(422, 'WRONG_ENVIRONMENT', 'This label belongs to another AYVO environment');
    }

    const { result, replayed } = await this.operations.run<StoredOutcome>(
      'LABEL_APPLICATION',
      request.requestId,
      { lotId: request.lotId, seriesCode: request.seriesCode, url: scan.url },
      async (tx) => {
        const bom = await this.inventory.activeBom('LABEL_APPLICATION', tx);
        const lotLines = bom.lines.filter((l) => l.item.lotTracking === 'REQUIRED');
        const lot = await this.inventory.getLot(request.lotId, tx);
        if (!lot || lotLines.length !== 1 || lot.itemId !== lotLines[0]!.itemId) {
          throw domainError(422, 'WRONG_LOT', 'The selected lot is not a lot of new bottles');
        }

        const bottle = await this.bottles.findByPublicToken(tx, scan.token);
        if (!bottle) throw domainError(422, 'UNKNOWN_LABEL', 'No bottle has this label');
        // The session's label run: a bottle of another series is never labelled here. The series
        // of a bottle is immutable, so no lock is needed for this check.
        if (bottle.creationBatch.code !== request.seriesCode) {
          throw domainError(
            422,
            'WRONG_SERIES',
            'This bottle does not belong to the series selected for this session',
          );
        }
        const label = await this.printJobs.latestCompletedLabel(tx, bottle.id, scan.url);
        if (!label) {
          throw domainError(
            422,
            'LABEL_NOT_PRINTED',
            'This label was never printed by a completed print job',
          );
        }

        const status = await this.bottles.lockForLabelApplication(tx, bottle.id);
        if (status === 'LABELED_EMPTY') {
          const event = await this.bottles.labelAppliedEvent(bottle.id, tx);
          if (!event) throw new Error('LABELED_EMPTY bottle without LABEL_APPLIED event');
          return { outcome: 'ALREADY_APPLIED', bottleId: bottle.id, eventId: event.id };
        }
        if (status !== 'CREATED') {
          throw domainError(
            422,
            'NOT_APPLICABLE',
            `A bottle in state ${status} cannot get its first label`,
          );
        }

        const location = await this.inventory.mainLocation(tx);
        const consumption = bom.lines
          .map((line) => ({
            line,
            itemId: line.itemId,
            locationId: location.id,
            lotId: line.item.lotTracking === 'REQUIRED' ? lot.id : null,
          }))
          .sort(byLockOrder);
        for (const c of consumption) {
          const onHand = await this.inventory.lockBalance(tx, c);
          if (onHand.lessThan(c.line.quantity)) {
            throw domainError(409, 'LOT_EXHAUSTED', 'The selected lot has no new bottle left');
          }
        }

        const occurredAt = new Date();
        const { eventId } = await this.bottles.applyLabelInTransaction(tx, {
          bottleId: bottle.id,
          occurredAt,
          labelQrUrl: scan.url,
          printJobId: label.printJobId,
          printJobPosition: label.position,
        });
        await this.inventory.postMovements(
          tx,
          consumption.map((c) => ({
            itemId: c.itemId,
            unitId: c.line.unitId,
            locationId: c.locationId,
            lotId: c.lotId,
            quantityDelta: c.line.quantity.negated(),
            type: 'LABEL_APPLICATION' as const,
            bottleEventId: eventId,
            bomLineId: c.line.id,
            occurredAt,
            requestId: request.requestId,
          })),
        );
        return { outcome: 'APPLIED', bottleId: bottle.id, eventId };
      },
    );
    return this.toResult(result, replayed, request.lotId);
  }

  private async toResult(
    stored: StoredOutcome,
    replayed: boolean,
    selectedLotId: string,
  ): Promise<LabelApplicationResult> {
    const [bottle, movements, selected] = await Promise.all([
      this.bottles.statusAndCode(stored.bottleId),
      this.inventory.movementsForBottleEvents([stored.eventId]),
      this.inventory.lotOnHand(selectedLotId),
    ]);
    const consumed = movements.find((m) => m.lot)?.lot;
    const event = await this.bottles.labelAppliedEvent(stored.bottleId);
    if (!consumed || !event || !selected) throw new Error('Inconsistent label application');
    return {
      outcome: stored.outcome,
      replayed,
      bottle: {
        code: bottle.code,
        status: bottle.status,
        labelAppliedAt: event.occurredAt.toISOString(),
      },
      consumedLot: { id: consumed.id, code: consumed.code },
      selectedLot: {
        id: selected.lot.id,
        code: selected.lot.code,
        onHand: formatQuantity(selected.onHand),
      },
    };
  }
}
