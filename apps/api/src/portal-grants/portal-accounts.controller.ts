import {
  portalAccountActivationSchema,
  type PortalAccountActivation,
  type PortalAccountListItem,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { UsersService } from '../identity/users.service.js';
import { PortalGrantsService } from './portal-grants.service.js';

/**
 * Hotely → Uživatelé: the hotel portal (PORTAL) accounts, kept apart from the internal users
 * (whose routes answer 404 for them). Read with the grant administrators' permission; deactivation
 * and reactivation additionally need the user administrators' permission, and use the same rules,
 * session revocation and audit as for internal accounts. Grants are issued, replaced and accounts
 * invited only through Finance's payer page; a grant is revoked by the existing core route.
 */
@Controller(`${ADMIN_PREFIX}/identity/portal-accounts`)
export class PortalAccountsController {
  constructor(
    private readonly grants: PortalGrantsService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @RequirePermission('identity:portal_grants_manage')
  list(): Promise<PortalAccountListItem[]> {
    return this.grants.accounts();
  }

  @Get(':id')
  @RequirePermission('identity:portal_grants_manage')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<PortalAccountListItem> {
    return this.one(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('identity:portal_grants_manage', 'identity:users_manage')
  async deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalAccountActivationSchema)) body: PortalAccountActivation,
  ): Promise<PortalAccountListItem> {
    await this.users.setPortalAccountActive(actorOf(principal), id, false, body.reason);
    return this.one(id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('identity:portal_grants_manage', 'identity:users_manage')
  async reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(portalAccountActivationSchema)) body: PortalAccountActivation,
  ): Promise<PortalAccountListItem> {
    await this.users.setPortalAccountActive(actorOf(principal), id, true, body.reason);
    return this.one(id);
  }

  private async one(id: string): Promise<PortalAccountListItem> {
    const found = (await this.grants.accounts(id))[0];
    if (!found) throw domainError(404, 'USER_NOT_FOUND', 'No such user');
    return found;
  }
}

const actorOf = (p: Principal) => ({ userId: p.userId, permissions: p.permissions });
