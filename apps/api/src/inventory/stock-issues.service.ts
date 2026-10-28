import type { CreateStockIssueRequest, StockIssueResult } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { assertUnitScale, formatQuantity, quantity } from '../common/quantity.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { InventoryService } from './inventory.service.js';
import type { WarehouseContext } from './warehouse-context.js';

/**
 * Manual issue of a consumable to consumption (owner 2026-10-27, doc 018 §5a) — e.g. one printer
 * ribbon roll (1 pcs = one roll of 300 m) put into a printer. Never a recipe, never an estimate per
 * label. One request id issues once (a repeat replays the result); the stock the user saw must
 * still be the stock (`STOCK_CHANGED` otherwise), so two clicks or two tabs never issue twice; the
 * ledger refuses a negative balance; every issue is audited with its reason.
 */
@Injectable()
export class StockIssuesService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
  ) {}

  async issue(
    actorId: string,
    warehouse: WarehouseContext,
    input: CreateStockIssueRequest,
  ): Promise<StockIssueResult> {
    const { result } = await this.operations.run(
      'STOCK_ISSUE',
      input.requestId,
      { actorId, locationId: warehouse.locationId, ...input },
      async (tx) => {
        const item = await this.inventory.getItemByCode(input.itemCode, tx);
        if (item.kind !== 'CONSUMABLE') {
          throw domainError(
            422,
            'NOT_CONSUMABLE',
            'Only a consumable is issued by hand; materials of a recipe are consumed by production',
          );
        }
        const amount = quantity(input.quantity);
        assertUnitScale(amount, item.baseUnit.decimalPlaces, 'Quantity');
        const tracked = item.lotTracking === 'REQUIRED';
        if (tracked !== (input.lotId !== null)) {
          throw tracked
            ? domainError(422, 'LOT_REQUIRED', 'Choose the lot the material is taken from')
            : domainError(422, 'LOT_NOT_ALLOWED', 'This item is not tracked by lots');
        }
        const lot = input.lotId ? await this.inventory.getLot(input.lotId, tx) : null;
        if (input.lotId && lot?.itemId !== item.id) {
          throw domainError(422, 'UNKNOWN_LOT', 'The lot does not belong to this item');
        }
        const key = { itemId: item.id, locationId: warehouse.locationId, lotId: input.lotId };
        const onHand = await this.inventory.lockBalance(tx, key);
        if (!onHand.eq(quantity(input.expectedOnHand))) {
          throw domainErrorWithDetails(
            409,
            'STOCK_CHANGED',
            'The stock changed meanwhile — check it and issue again if still needed',
            { onHand: formatQuantity(onHand) },
          );
        }
        if (onHand.lessThan(amount)) {
          throw domainError(409, 'INSUFFICIENT_STOCK', 'Not enough stock to issue this quantity');
        }
        const occurredAt = new Date();
        const issue = await tx.stockIssue.create({
          data: {
            itemId: item.id,
            unitId: item.baseUnitId,
            locationId: warehouse.locationId,
            lotId: input.lotId,
            quantity: amount,
            reason: input.reason,
            actorId,
            occurredAt,
            requestId: input.requestId,
          },
        });
        const [movement] = await this.inventory.postMovements(tx, [
          {
            ...key,
            unitId: item.baseUnitId,
            quantityDelta: amount.negated(),
            type: 'CONSUMPTION_ISSUE',
            stockIssueId: issue.id,
            occurredAt,
            requestId: input.requestId,
          },
        ]);
        await this.audit.record(
          {
            type: 'STOCK_ISSUED',
            actorUserId: actorId,
            siteId: warehouse.siteId,
            reason: input.reason,
            payload: {
              item: item.code,
              lot: lot?.code ?? null,
              quantity: formatQuantity(amount),
              unit: item.baseUnit.code,
              location: warehouse.locationCode,
              balanceAfter: formatQuantity(movement!.balanceAfter),
            },
          },
          tx,
        );
        return {
          itemCode: item.code,
          lot: lot ? { id: lot.id, code: lot.code } : null,
          quantity: formatQuantity(amount),
          balanceAfter: formatQuantity(movement!.balanceAfter),
          occurredAt: occurredAt.toISOString(),
        };
      },
    );
    return result;
  }
}
