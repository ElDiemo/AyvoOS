import {
  updatePplSettingsRequestSchema,
  verifyCarrierRequestSchema,
  type PplSettings,
  type UpdatePplSettingsRequest,
  type VerifyCarrierRequest,
  type VerifyCarrierResult,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { CarrierSettingsService } from './carrier-settings.service.js';

/**
 * Správa systému → Provozovny → Dopravci a expedice (doc 029 §9): PPL settings of a site, ADMIN
 * only (`sites:carrier_manage`). Never returns or accepts a secret or an API URL.
 */
@Controller(`${ADMIN_PREFIX}/sites/:siteId/carriers/ppl`)
export class CarrierSettingsController {
  constructor(private readonly settings: CarrierSettingsService) {}

  @RequirePermission('sites:carrier_manage')
  @Get()
  view(@Param('siteId', new ParseUUIDPipe()) siteId: string): Promise<PplSettings> {
    return this.settings.view(siteId);
  }

  @RequirePermission('sites:carrier_manage')
  @Put()
  update(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body(new ZodValidationPipe(updatePplSettingsRequestSchema)) body: UpdatePplSettingsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PplSettings> {
    return this.settings.update(principal.userId, siteId, body);
  }

  /** Token + product list at PPL; creates no shipment and orders no pickup. */
  @RequirePermission('sites:carrier_manage')
  @Post('verify')
  @HttpCode(200)
  verify(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body(new ZodValidationPipe(verifyCarrierRequestSchema)) body: VerifyCarrierRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<VerifyCarrierResult> {
    return this.settings.verify(principal.userId, siteId, body);
  }
}
