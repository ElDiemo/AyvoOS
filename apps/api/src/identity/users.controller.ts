import {
  createUserRequestSchema,
  invitationActionRequestSchema,
  type InvitationActionRequest,
  roleChangeRequestSchema,
  siteScopeRequestSchema,
  statusChangeRequestSchema,
  warehouseScopeRequestSchema,
  type AdminUserDetail,
  type AdminUserSummary,
  type CreateUserRequest,
  type RoleChangeRequest,
  type SiteScopeRequest,
  type StatusChangeRequest,
  type WarehouseScopeRequest,
} from '@ayvo/types';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import type { Principal } from './principal.js';
import { UsersService, type Actor } from './users.service.js';

const ID = new ParseUUIDPipe();
const actor = (p: Principal): Actor => ({ userId: p.userId, permissions: p.permissions });

/** User and role administration (ADMIN). Every mutation needs a reason and is audited. */
@Controller(`${ADMIN_PREFIX}/identity`)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Sites and their warehouses, for assigning access. */
  @Get('sites')
  @RequirePermission('identity:users_read')
  sites() {
    return this.users.sitesForAssignment();
  }

  @Get('warehouses')
  @RequirePermission('identity:users_read')
  warehouses() {
    return this.users.warehouses();
  }

  @Get('users')
  @RequirePermission('identity:users_read')
  list(): Promise<AdminUserSummary[]> {
    return this.users.list();
  }

  @Post('users')
  @RequirePermission('identity:users_manage')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<AdminUserDetail> {
    return this.users.create(actor(principal), body);
  }

  @Get('users/:id')
  @RequirePermission('identity:users_read')
  get(@Param('id', ID) id: string): Promise<AdminUserDetail> {
    return this.users.get(id);
  }

  @Post('users/:id/roles/grant')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  grantRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(roleChangeRequestSchema)) body: RoleChangeRequest,
  ) {
    return this.users.grantRole(actor(principal), id, body.role, body.reason);
  }

  @Post('users/:id/roles/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(roleChangeRequestSchema)) body: RoleChangeRequest,
  ) {
    return this.users.revokeRole(actor(principal), id, body.role, body.reason);
  }

  /** Sends an invitation to register (ADMIN; idempotent per requestId). */
  @Post('users/:id/invitations')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  sendInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(invitationActionRequestSchema)) body: InvitationActionRequest,
  ) {
    return this.users.sendInvitation(actor(principal), id, body.requestId, body.reason);
  }

  @Post('users/:id/invitations/resend')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  resendInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(invitationActionRequestSchema)) body: InvitationActionRequest,
  ) {
    return this.users.resendInvitation(actor(principal), id, body.requestId, body.reason);
  }

  @Post('users/:id/invitations/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(invitationActionRequestSchema)) body: InvitationActionRequest,
  ) {
    return this.users.revokeInvitation(actor(principal), id, body.requestId, body.reason);
  }

  @Post('users/:id/sites/grant')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  grantSite(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(siteScopeRequestSchema)) body: SiteScopeRequest,
  ) {
    return this.users.grantSite(actor(principal), id, body.siteId, body.reason);
  }

  @Post('users/:id/sites/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeSite(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(siteScopeRequestSchema)) body: SiteScopeRequest,
  ) {
    return this.users.revokeSite(actor(principal), id, body.siteId, body.reason);
  }

  @Post('users/:id/warehouses/grant')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  grantWarehouse(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(warehouseScopeRequestSchema)) body: WarehouseScopeRequest,
  ) {
    return this.users.grantWarehouse(actor(principal), id, body.warehouseCode, body.reason);
  }

  @Post('users/:id/warehouses/revoke')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  revokeWarehouse(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(warehouseScopeRequestSchema)) body: WarehouseScopeRequest,
  ) {
    return this.users.revokeWarehouse(actor(principal), id, body.warehouseCode, body.reason);
  }

  @Post('users/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ) {
    return this.users.deactivate(actor(principal), id, body.reason);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('identity:users_manage')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ID) id: string,
    @Body(new ZodValidationPipe(statusChangeRequestSchema)) body: StatusChangeRequest,
  ) {
    return this.users.reactivate(actor(principal), id, body.reason);
  }
}
