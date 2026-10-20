import {
  replaceCarrierCredentialsRequestSchema,
  type CarrierConnectionAdmin,
  type ReplaceCarrierCredentialsRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { CarrierCredentialsService } from './carrier-credentials.service.js';

/**
 * Správa systému → Dopravci (ADR 0027): the server-side carrier connections and their credentials,
 * ADMIN only (`carriers:connections_manage`). The secret is write-only: accepted on replacement,
 * never returned. Base URLs are fixed in code and not part of any contract.
 */
@Controller(`${ADMIN_PREFIX}/carrier-connections`)
export class CarrierConnectionsController {
  constructor(private readonly credentials: CarrierCredentialsService) {}

  @RequirePermission('carriers:connections_manage')
  @Get()
  list(): Promise<CarrierConnectionAdmin[]> {
    return this.credentials.adminList();
  }

  @RequirePermission('carriers:connections_manage')
  @Post(':code/credentials')
  @HttpCode(200)
  replace(
    @Param('code') code: string,
    @Body(new ZodValidationPipe(replaceCarrierCredentialsRequestSchema))
    body: ReplaceCarrierCredentialsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CarrierConnectionAdmin[]> {
    return this.credentials.replace(principal.userId, code, body);
  }
}
