import {
  bottleCodeSchema,
  createStockIssueRequestSchema,
  inventoryItemCodeSchema,
  movementListQuerySchema,
  updateItemSettingsRequestSchema,
  type BottlePhysical,
  type CreateStockIssueRequest,
  type InventoryItem,
  type InventoryLot,
  type InventoryMovementPage,
  type MovementListQuery,
  type StockOverview,
  type StockIssueResult,
  type StockSummary,
  type UpdateItemSettingsRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WarehouseReadService } from './warehouse-read.service.js';
import { RequirePermission } from '../identity/access.decorators.js';
import {
  CurrentPrincipal,
  OperationalSite,
  OperationalWarehouse,
} from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { StockIssuesService } from '../inventory/stock-issues.service.js';
import type { SiteContext, WarehouseContext } from '../inventory/warehouse-context.js';

const ITEM_CODE = new ZodValidationPipe(inventoryItemCodeSchema);
const lotQuerySchema = z.object({
  item: inventoryItemCodeSchema,
  available: z.enum(['true', 'false']).default('true'),
});

/** Admin API of the warehouse screens (doc 018); permissions per route (doc 021). */
@Controller(ADMIN_PREFIX)
export class WarehouseController {
  constructor(
    private readonly read: WarehouseReadService,
    private readonly inventory: InventoryService,
    private readonly issues: StockIssuesService,
  ) {}

  /**
   * Issues a consumable (e.g. a printer ribbon roll) to consumption by hand at the active site's
   * warehouse, with a reason (owner 2026-10-27, doc 018 §5a).
   */
  @RequirePermission('inventory:consume')
  @Post('inventory/issues')
  @HttpCode(201)
  issue(
    @Body(new ZodValidationPipe(createStockIssueRequestSchema)) body: CreateStockIssueRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalWarehouse() warehouse: WarehouseContext,
  ): Promise<StockIssueResult> {
    return this.issues.issue(principal.userId, warehouse, body);
  }

  /**
   * RETIRED (doc 025 A3, owner B4): a label is applied only at a labelling station into a crate
   * (POST /api/admin/station-sessions/:id/label-scans). The standalone application answers 410
   * and writes nothing; the database refuses a new LABEL_APPLIED without a crate cycle as well.
   */
  @RequirePermission('production:label_apply')
  @Post('label-applications')
  @HttpCode(410)
  retired(): never {
    throw new HttpException(
      {
        statusCode: 410,
        code: 'LABEL_APPLICATION_RETIRED',
        message: 'Labels are applied at a labelling station into a crate',
      },
      410,
    );
  }

  /** Recent applications at the active site's warehouse (production of that site). */
  @RequirePermission('production:read')
  @Get('label-applications')
  async recent(@OperationalSite() site: SiteContext) {
    const warehouse = await this.inventory.siteDefaultLocation(site.siteId);
    return { items: await this.read.recentApplications(20, warehouse?.id ?? null) };
  }

  @RequirePermission('production:read')
  @Get('bottles/:code/physical')
  physical(
    @Param('code', new ZodValidationPipe(bottleCodeSchema)) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<BottlePhysical> {
    return this.read.physical(code, site.siteId);
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

  /** Read-only availability for planning (inventory:stock_summary); no operational, supplier or cost details. */
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
