import {
  bottleCodeSchema,
  inventoryItemCodeSchema,
  labelApplicationRequestSchema,
  movementListQuerySchema,
  updateItemSettingsRequestSchema,
  type BottlePhysical,
  type InventoryItem,
  type InventoryLot,
  type InventoryMovementPage,
  type LabelApplicationRequest,
  type LabelApplicationResult,
  type MovementListQuery,
  type StockOverview,
  type UpdateItemSettingsRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LabelApplicationService } from './label-application.service.js';
import { WarehouseReadService } from './warehouse-read.service.js';

const ITEM_CODE = new ZodValidationPipe(inventoryItemCodeSchema);
const lotQuerySchema = z.object({
  item: inventoryItemCodeSchema,
  available: z.enum(['true', 'false']).default('true'),
});

/**
 * Admin API of the warehouse screens (doc 018). Future permissions: warehouse.label.apply,
 * inventory.read, inventory.items.manage.
 */
@Controller(ADMIN_PREFIX)
export class WarehouseController {
  constructor(
    private readonly labels: LabelApplicationService,
    private readonly read: WarehouseReadService,
  ) {}

  /** The physical label scan. 200 for APPLIED / ALREADY_APPLIED; 4xx with a stable code otherwise. */
  @Post('label-applications')
  @HttpCode(200)
  apply(
    @Body(new ZodValidationPipe(labelApplicationRequestSchema)) body: LabelApplicationRequest,
  ): Promise<LabelApplicationResult> {
    return this.labels.apply(body);
  }

  @Get('label-applications')
  async recent() {
    return { items: await this.read.recentApplications(20) };
  }

  @Get('bottles/:code/physical')
  physical(
    @Param('code', new ZodValidationPipe(bottleCodeSchema)) code: string,
  ): Promise<BottlePhysical> {
    return this.read.physical(code);
  }

  @Get('inventory/items')
  items(): Promise<InventoryItem[]> {
    return this.read.items();
  }

  @Post('inventory/items/:code/settings')
  @HttpCode(200)
  settings(
    @Param('code', ITEM_CODE) code: string,
    @Body(new ZodValidationPipe(updateItemSettingsRequestSchema)) body: UpdateItemSettingsRequest,
  ): Promise<InventoryItem> {
    return this.read.updateSettings(code, body);
  }

  @Get('inventory/stock')
  stock(): Promise<StockOverview> {
    return this.read.stock();
  }

  @Get('inventory/lots')
  lots(
    @Query(new ZodValidationPipe(lotQuerySchema)) q: z.infer<typeof lotQuerySchema>,
  ): Promise<InventoryLot[]> {
    return this.read.lots(q.item, q.available === 'true');
  }

  @Get('inventory/movements')
  movements(
    @Query(new ZodValidationPipe(movementListQuerySchema)) query: MovementListQuery,
  ): Promise<InventoryMovementPage> {
    return this.read.movements(query);
  }
}
