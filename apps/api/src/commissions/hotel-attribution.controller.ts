import {
  portfolioQuerySchema,
  recordHotelAttributionSchema,
  type HotelAttribution,
  type Portfolio,
  type PortfolioQuery,
  type RecordHotelAttributionRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { HotelAttributionService } from './hotel-attribution.service.js';

/**
 * Obchod → Provize — who gets the commission for a hotel (doc 068 §4.2, PR 1b). Existing
 * permissions only (Q5): attribution on the hotel card with `sales:manage` + `hotels:read`, the
 * portfolio with `sales:work` (own hotels; another salesperson only with `sales:manage`). No PUT,
 * PATCH or DELETE: a change is a new revision.
 */
@Controller(ADMIN_PREFIX)
export class HotelAttributionController {
  constructor(private readonly attribution: HotelAttributionService) {}

  @Get('hotels/:code/sales-attribution')
  @RequirePermission('sales:manage', 'hotels:read')
  detail(@Param('code') code: string, @CurrentPrincipal() p: Principal): Promise<HotelAttribution> {
    return this.attribution.detail(code, p);
  }

  @Post('hotels/:code/sales-attribution')
  @HttpCode(201)
  @RequirePermission('sales:manage', 'hotels:read')
  record(
    @Param('code') code: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(recordHotelAttributionSchema)) body: RecordHotelAttributionRequest,
  ): Promise<HotelAttribution> {
    return this.attribution.record(code, body, p);
  }

  @Get('sales/portfolio')
  @RequirePermission('sales:work')
  portfolio(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(portfolioQuerySchema)) q: PortfolioQuery,
  ): Promise<Portfolio> {
    return this.attribution.portfolio(q, p);
  }
}
