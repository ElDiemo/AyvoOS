import {
  createHotelRequestSchema,
  hotelCodeSchema,
  type CreateHotelRequest,
  type FulfillmentSiteOption,
  type HotelDetail,
  type HotelSummary,
} from '@ayvo/types';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { HotelsService } from './hotels.service.js';

/** Hotely (doc 028): company-wide hotel master data. */
@Controller(`${ADMIN_PREFIX}/hotels`)
export class HotelsController {
  constructor(private readonly hotels: HotelsService) {}

  @RequirePermission('hotels:read')
  @Get()
  list(): Promise<HotelSummary[]> {
    return this.hotels.list();
  }

  @RequirePermission('hotels:manage')
  @Get('fulfillment-sites')
  fulfillmentSites(): Promise<FulfillmentSiteOption[]> {
    return this.hotels.fulfillmentSites();
  }

  @RequirePermission('hotels:read')
  @Get(':code')
  detail(
    @Param('code', new ZodValidationPipe(hotelCodeSchema)) code: string,
  ): Promise<HotelDetail> {
    return this.hotels.detail(code);
  }

  @RequirePermission('hotels:manage')
  @Post()
  create(
    @Body(new ZodValidationPipe(createHotelRequestSchema)) body: CreateHotelRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HotelDetail> {
    return this.hotels.create(principal.userId, body);
  }
}
