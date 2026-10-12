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
  type StockSummary,
  type UpdateItemSettingsRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LabelApplicationService } from './label-application.service.js';
import { WarehouseReadService } from './warehouse-read.service.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalWarehouse } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { WarehouseContext } from '../inventory/warehouse-context.js';

const ITEM_CODE = new ZodValidationPipe(inventoryItemCodeSchema);
const lotQuerySchema = z.object({
  item: inventoryItemCodeSchema,
  available: z.enum(['true', 'false']).default('true'),
});

/** Admin API of the warehouse screens (doc 018); permissions per route (doc 021). */
@Controller(ADMIN_PREFIX)
export class WarehouseController {
  constructor(
    private readonly labels: LabelApplicationService,
    private readonly read: WarehouseReadService,
    private readonly inventory: InventoryService,
  ) {}

  /** The physical label scan. 200 for APPLIED / ALREADY_APPLIED; 4xx with a stable code otherwise. */
  @RequirePermission('production:label_apply')
  @Post('label-applications')
  @HttpCode(200)
  apply(
    @Body(new ZodValidationPipe(labelApplicationRequestSchema)) body: LabelApplicationRequest,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<LabelApplicationResult> {
    return this.labels.apply(body, warehouse);
  }

  /** Recent applications at the active site's warehouse (none without an active site). */
  @RequirePermission('production:read')
  @Get('label-applications')
  async recent(@CurrentPrincipal() principal: Principal) {
    const site = principal.activeSite;
    const warehouse = site ? await this.inventory.siteDefaultLocation(site.id) : null;
    return { items: await this.read.recentApplications(20, warehouse?.id ?? null) };
  }

  @RequirePermission('production:read')
  @Get('bottles/:code/physical')
  physical(
    @Param('code', new ZodValidationPipe(bottleCodeSchema)) code: string,
  ): Promise<BottlePhysical> {
    return this.read.physical(code);
  }

  @RequirePermission('inventory:read')
  @Get('inventory/items')
  items(): Promise<InventoryItem[]> {
    return this.read.items();
  }

  @RequirePermission('inventory:items_manage')
  @Post('inventory/items/:code/settings')
  @HttpCode(200)
  settings(
    @Param('code', ITEM_CODE) code: string,
    @Body(new ZodValidationPipe(updateItemSettingsRequestSchema)) body: UpdateItemSettingsRequest,
  ): Promise<InventoryItem> {
    return this.read.updateSettings(code, body);
  }

  @RequirePermission('inventory:read')
  @Get('inventory/stock')
  stock(@OperationalWarehouse() warehouse: WarehouseContext): Promise<StockOverview> {
    return this.read.stock(warehouse);
  }

  /** Read-only availability for planning (SALES); no operational, supplier or cost details. */
  @RequirePermission('inventory:stock_summary')
  @Get('inventory/stock-summary')
  stockSummary(@OperationalWarehouse() warehouse: WarehouseContext): Promise<StockSummary> {
    return this.read.stockSummary(warehouse);
  }

  @RequirePermission('inventory:read')
  @Get('inventory/lots')
  lots(
    @Query(new ZodValidationPipe(lotQuerySchema)) q: z.infer<typeof lotQuerySchema>,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<InventoryLot[]> {
    return this.read.lots(q.item, q.available === 'true', warehouse);
  }

  @RequirePermission('inventory:read')
  @Get('inventory/movements')
  movements(
    @Query(new ZodValidationPipe(movementListQuerySchema)) query: MovementListQuery,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<InventoryMovementPage> {
    return this.read.movements(query, warehouse);
  }
}
