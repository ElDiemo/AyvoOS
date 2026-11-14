import {
  cancelPickupRequestSchema,
  lookupPickupRequestSchema,
  orderPickupRequestSchema,
  pickupCodeSchema,
  resolvePickupCancelRequestSchema,
  resolvePickupRequestSchema,
  type CancelPickupRequest,
  type ResolvePickupCancelRequest,
  type LookupPickupRequest,
  type ResolvePickupRequest,
  type OrderPickupRequest,
  type PickupBoard,
  type PickupView,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal, OperationalSite } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import type { SiteContext } from '../inventory/warehouse-context.js';
import { CarrierPickupsService } from './carrier-pickups.service.js';

const CODE = new ZodValidationPipe(pickupCodeSchema);

/**
 * Expedice → Svoz (doc 029 §11): the active site's labelled orders ready for pickup and its
 * pickup orders at the carrier. Reading needs `shipments:read`; ordering and looking a pickup up
 * at the carrier need `shipments:prepare` (doc 029 §6) — checked on every request and replay.
 */
@Controller(`${ADMIN_PREFIX}/dispatch/pickups`)
export class CarrierPickupsController {
  constructor(private readonly pickups: CarrierPickupsService) {}

  @RequirePermission('shipments:read')
  @Get()
  board(@OperationalSite() site: SiteContext): Promise<PickupBoard> {
    return this.pickups.board(site);
  }

  @RequirePermission('shipments:read')
  @Get(':code')
  view(
    @Param('code', CODE) code: string,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.view(site, code);
  }

  /** "Objednat svoz PPL": one explicit pickup order for the active site. */
  @RequirePermission('shipments:prepare')
  @Post()
  @HttpCode(200)
  order(
    @Body(new ZodValidationPipe(orderPickupRequestSchema)) body: OrderPickupRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.order(principal.userId, site, body);
  }

  /** "Zjistit stav u dopravce": read-only at the carrier; never sends the pickup again. */
  @RequirePermission('shipments:prepare')
  @Post(':code/lookup')
  @HttpCode(200)
  lookup(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(lookupPickupRequestSchema)) body: LookupPickupRequest,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.lookup(site, code, body);
  }

  /**
   * "Zrušit svoz": one cancellation at the carrier of a pickup it confirmed. The parcels stay
   * blocked for another pickup until the carrier shows the order cancelled.
   */
  @RequirePermission('shipments:prepare')
  @Post(':code/cancel')
  @HttpCode(200)
  cancel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(cancelPickupRequestSchema)) body: CancelPickupRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.cancel(principal.userId, site, code, body);
  }

  /**
   * The exceptional closing of an uncertain cancellation attempt, after verifying with the carrier
   * that it was not carried out; the pickup keeps its own state and a new request may follow.
   */
  @RequirePermission('shipments:resolve_uncertain')
  @Post(':code/cancel/resolve')
  @HttpCode(200)
  resolveCancel(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(resolvePickupCancelRequestSchema)) body: ResolvePickupCancelRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.resolveCancel(principal.userId, site, code, body);
  }

  /** The exceptional closing of an uncertain pickup, after checking with the carrier. */
  @RequirePermission('shipments:resolve_uncertain')
  @Post(':code/resolve')
  @HttpCode(200)
  resolve(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(resolvePickupRequestSchema)) body: ResolvePickupRequest,
    @CurrentPrincipal() principal: Principal,
    @OperationalSite() site: SiteContext,
  ): Promise<PickupView> {
    return this.pickups.resolve(principal.userId, site, code, body);
  }
}
