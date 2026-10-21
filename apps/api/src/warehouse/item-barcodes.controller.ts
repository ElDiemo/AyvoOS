import {
  assignBarcodeRequestSchema,
  inventoryItemCodeSchema,
  retireBarcodeRequestSchema,
  scannedCodeSchema,
  type AssignBarcodeRequest,
  type BarcodeLookup,
  type ItemBarcodes,
  type RetireBarcodeRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { ItemBarcodesService } from '../inventory/item-barcodes.service.js';

const ITEM_CODE = new ZodValidationPipe(inventoryItemCodeSchema);
const lookupQuerySchema = z.object({ code: scannedCodeSchema });

/**
 * Goods barcodes of stock items (doc 033). Reading needs inventory:read; assigning and retiring
 * inventory:barcodes_manage (ADMIN). Items are company-wide, like their codes.
 */
@Controller(ADMIN_PREFIX)
export class ItemBarcodesController {
  constructor(private readonly barcodes: ItemBarcodesService) {}

  /** The scan of the receipt form: reads only, never receives or moves stock. */
  @RequirePermission('inventory:read')
  @Get('inventory/barcodes/lookup')
  lookup(
    @Query(new ZodValidationPipe(lookupQuerySchema)) q: z.infer<typeof lookupQuerySchema>,
  ): Promise<BarcodeLookup> {
    return this.barcodes.lookup(q.code);
  }

  @RequirePermission('inventory:read')
  @Get('inventory/items/:code/barcodes')
  list(@Param('code', ITEM_CODE) code: string): Promise<ItemBarcodes> {
    return this.barcodes.list(code);
  }

  @RequirePermission('inventory:barcodes_manage')
  @Post('inventory/items/:code/barcodes')
  assign(
    @Param('code', ITEM_CODE) code: string,
    @Body(new ZodValidationPipe(assignBarcodeRequestSchema)) body: AssignBarcodeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ItemBarcodes> {
    return this.barcodes.assign(code, body, principal.userId);
  }

  @RequirePermission('inventory:barcodes_manage')
  @Post('inventory/barcodes/:id/retire')
  @HttpCode(200)
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(retireBarcodeRequestSchema)) body: RetireBarcodeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ItemBarcodes> {
    return this.barcodes.retire(id, body, principal.userId);
  }
}
