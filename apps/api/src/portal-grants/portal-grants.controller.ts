import {
  portalGrantRevokeRequestSchema,
  type PortalGrant,
  type PortalGrantRevokeRequest,
} from '@ayvo/types';
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { PortalGrantsService } from './portal-grants.service.js';

/**
 * Revocation of a hotel portal grant (ADR 0045 §4): core only, no Finance check (narrowing to
 * nothing). Issuing and replacing are not here — they come only through Finance's contract.
 */
@Controller(`${ADMIN_PREFIX}/identity/portal-grants`)
export class PortalGrantsController {
  constructor(private readonly grants: PortalGrantsService) {}

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('identity:portal_grants_manage')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalGrantRevokeRequestSchema)) body: PortalGrantRevokeRequest,
  ): Promise<PortalGrant> {
    return this.grants.revoke(principal.userId, id, body.reason);
  }
}
