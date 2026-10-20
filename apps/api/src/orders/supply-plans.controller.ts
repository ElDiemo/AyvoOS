import {
  activateSupplyPlanRequestSchema,
  hotelCodeSchema,
  pauseSupplyPlanRequestSchema,
  saveSupplyPlanRequestSchema,
  supplyPlanPreviewRequestSchema,
  type ActivateSupplyPlanRequest,
  type PauseSupplyPlanRequest,
  type SaveSupplyPlanRequest,
  type SupplyPlanPreviewRequest,
  type SupplyPlanResponse,
  type SupplyPreview,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { SupplyPlansService } from './supply-plans.service.js';

const HOTEL = new ZodValidationPipe(hotelCodeSchema);

/**
 * Plán zásobování of a hotel served by the active site (doc 032). Reading with orders:read;
 * managing (save, preview, switch on, pause) with orders:plan_manage — ADMIN only for now.
 */
@Controller(`${ADMIN_PREFIX}/orders/hotel/:hotel/supply-plan`)
export class SupplyPlansController {
  constructor(private readonly plans: SupplyPlansService) {}

  @RequirePermission('orders:read')
  @Get()
  async get(
    @Param('hotel', HOTEL) hotel: string,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplyPlanResponse> {
    return { plan: await this.plans.get(site, hotel) };
  }

  /** Evaluates a plan for the next 30 days; writes nothing. */
  @RequirePermission('orders:plan_manage')
  @Post('preview')
  @HttpCode(200)
  preview(
    @Param('hotel', HOTEL) hotel: string,
    @Body(new ZodValidationPipe(supplyPlanPreviewRequestSchema)) body: SupplyPlanPreviewRequest,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplyPreview> {
    return this.plans.preview(site, hotel, body);
  }

  @RequirePermission('orders:plan_manage')
  @Post()
  @HttpCode(200)
  async save(
    @Param('hotel', HOTEL) hotel: string,
    @Body(new ZodValidationPipe(saveSupplyPlanRequestSchema)) body: SaveSupplyPlanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplyPlanResponse> {
    return { plan: await this.plans.save(principal.userId, site, hotel, body) };
  }

  @RequirePermission('orders:plan_manage')
  @Post('activate')
  @HttpCode(200)
  async activate(
    @Param('hotel', HOTEL) hotel: string,
    @Body(new ZodValidationPipe(activateSupplyPlanRequestSchema)) body: ActivateSupplyPlanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplyPlanResponse> {
    return { plan: await this.plans.activate(principal.userId, site, hotel, body) };
  }

  @RequirePermission('orders:plan_manage')
  @Post('pause')
  @HttpCode(200)
  async pause(
    @Param('hotel', HOTEL) hotel: string,
    @Body(new ZodValidationPipe(pauseSupplyPlanRequestSchema)) body: PauseSupplyPlanRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<SupplyPlanResponse> {
    return { plan: await this.plans.pause(principal.userId, site, hotel, body) };
  }
}
